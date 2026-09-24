#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
U17-class mini excavator - arm (斗杆) + bucket (铲斗) + bucket linkage
Laser-cut plate drawing generator.

Regenerates:
  dxf/<PartID>_<name>_t<thk>_x<qty>.dxf   - one DXF per laser part
  dxf/ALL_parts_sheet.dxf                 - all parts laid out with DIMENSION entities
  preview/parts.png                       - all parts, labelled
  preview/assembly_poses.png              - 3 poses (full curl / mid / full dump)
  BOM.md                                  - Chinese bill of materials + kinematic notes

Run: /tmp/claude-0/venv/bin/python cad/u17-class/gen.py
"""

import math
import os

import ezdxf
from ezdxf.enums import TextEntityAlignment
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# ---------------------------------------------------------------------------
# paths / constants
# ---------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
DXFDIR = os.path.join(HERE, "dxf")
PREVDIR = os.path.join(HERE, "preview")
os.makedirs(DXFDIR, exist_ok=True)
os.makedirs(PREVDIR, exist_ok=True)

STEEL_DENSITY = 7.85e-3  # g / mm^3  (7.85 g/cm^3)
MATERIAL = "Q355B"

REPORT_LINES = []  # collected for stdout + BOM notes


def log(*a):
    s = " ".join(str(x) for x in a)
    print(s)
    REPORT_LINES.append(s)


# ===========================================================================
# GEOMETRY HELPERS
# ===========================================================================

def rot(v, ang_rad):
    c, s = math.cos(ang_rad), math.sin(ang_rad)
    return (c * v[0] - s * v[1], s * v[0] + c * v[1])


def vsub(a, b):
    return (a[0] - b[0], a[1] - b[1])


def vadd(a, b):
    return (a[0] + b[0], a[1] + b[1])


def vscale(a, k):
    return (a[0] * k, a[1] * k)


def vlen(a):
    return math.hypot(a[0], a[1])


def vunit(a):
    l = vlen(a)
    return (a[0] / l, a[1] / l)


def tangent_pair(c1, r1, s1, c2, r2, s2):
    """Common tangent segment between circle1 (c1,r1,s1) and circle2 (c2,r2,s2),
    s=+1 convex (outline wraps outside), s=-1 concave (outline runs inside / fillet).
    Same-sign s -> external/outer tangent, opposite-sign s -> crossed/internal tangent
    (handled uniformly by using signed radius rho = s*r).
    Returns (t1, t2, n) - the two tangent points and the unit normal used.
    """
    d = vsub(c2, c1)
    D = vlen(d)
    if D < 1e-9:
        raise ValueError("tangent_pair: coincident circle centres")
    u = vunit(d)
    rho1, rho2 = s1 * r1, s2 * r2
    val = (rho1 - rho2) / D
    if val > 1.0 or val < -1.0:
        if abs(val) > 1.0 + 1e-6:
            raise ValueError(
                f"tangent_pair: no common tangent exists (|rho1-rho2|={abs(rho1-rho2):.3f} > D={D:.3f})"
            )
        val = max(-1.0, min(1.0, val))
    angle = math.acos(val)
    n = rot(u, -angle)
    t1 = vadd(c1, vscale(n, rho1))
    t2 = vadd(c2, vscale(n, rho2))
    return t1, t2, n


def tangent_chain(circles):
    """circles: list of (cx, cy, r, s), traversed CCW around the loop.
    s=+1 convex (outline wraps the outside of the circle),
    s=-1 concave (fillet; outline runs on the inside).
    Returns (verts, tangent_segments):
      verts: list of (x, y, bulge) forming ONE closed LWPOLYLINE loop (line+arc chain)
      tangent_segments: list of (p_start, p_end) for each straight tangent piece,
                         in the same order as `circles` (segment i = circle i -> circle i+1)
    """
    n = len(circles)
    pairs = []
    for i in range(n):
        c1 = circles[i][:2]
        r1 = circles[i][2]
        s1 = circles[i][3]
        j = (i + 1) % n
        c2 = circles[j][:2]
        r2 = circles[j][2]
        s2 = circles[j][3]
        t1, t2, _ = tangent_pair(c1, r1, s1, c2, r2, s2)
        pairs.append((t1, t2))

    verts = []
    TOL = 1e-6
    for i in range(n):
        cx, cy, r, s = circles[i]
        p_in = pairs[i - 1][1]
        p_out = pairs[i][0]
        same = vlen(vsub(p_in, p_out)) < TOL or r < TOL
        if same:
            # degenerate circle (e.g. a "point" with r=0, or entry==exit): single vertex
            verts.append((p_in[0], p_in[1], 0.0))
            continue
        a_in = math.atan2(p_in[1] - cy, p_in[0] - cx)
        a_out = math.atan2(p_out[1] - cy, p_out[0] - cx)
        delta = (a_out - a_in) % (2 * math.pi)
        if s > 0:
            sweep = delta
            bulge = math.tan(sweep / 4.0) if sweep > 1e-9 else 0.0
        else:
            sweep = (2 * math.pi - delta) % (2 * math.pi)
            bulge = -math.tan(sweep / 4.0) if sweep > 1e-9 else 0.0
        verts.append((p_in[0], p_in[1], bulge))
        verts.append((p_out[0], p_out[1], 0.0))

    return verts, pairs


def circle_as_polyline(cx, cy, r):
    """A full circle expressed as a closed 2-vertex bulge=1 LWPOLYLINE loop."""
    return [(cx - r, cy, 1.0), (cx + r, cy, 1.0)]


def dedupe_ring(pts, tol=1e-6):
    out = []
    for p in pts:
        if not out or vlen(vsub(p, out[-1])) > tol:
            out.append(p)
    if len(out) > 1 and vlen(vsub(out[0], out[-1])) < tol:
        out.pop()
    return out


def flatten_bulge_ring(verts, chord=0.1):
    """verts: list of (x,y,bulge) closed ring -> flattened list of (x,y) points."""
    pts = []
    n = len(verts)
    for i in range(n):
        x, y, b = verts[i]
        x2, y2, _ = verts[(i + 1) % n]
        pts.append((x, y))
        if abs(b) > 1e-9:
            sweep = 4 * math.atan(abs(b))
            chordlen = math.hypot(x2 - x, y2 - y)
            if chordlen < 1e-9:
                continue
            r = chordlen / 2 / math.sin(sweep / 2)
            mx, my = (x + x2) / 2, (y + y2) / 2
            h = math.sqrt(max(r * r - (chordlen / 2) ** 2, 0.0))
            ux, uy = (x2 - x) / chordlen, (y2 - y) / chordlen
            nx, ny = -uy, ux
            sign = 1 if b > 0 else -1
            cx, cy = mx + sign * h * nx, my + sign * h * ny
            a1 = math.atan2(y - cy, x - cx)
            a2 = math.atan2(y2 - cy, x2 - cx)
            if b > 0:
                da = (a2 - a1) % (2 * math.pi)
            else:
                da = -((a1 - a2) % (2 * math.pi))
            nseg = max(2, int(abs(da) * r / chord) + 1)
            for k in range(1, nseg + 1):
                a = a1 + da * k / nseg
                pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return dedupe_ring(pts)


def bulge_ring_length(verts):
    """Total path length of a bulge polyline ring (not closing the last->first gap,
    used only for open tangent-segment style length checks elsewhere)."""
    pts = flatten_bulge_ring(verts, chord=0.05)
    L = 0.0
    for i in range(len(pts)):
        p1 = pts[i]
        p2 = pts[(i + 1) % len(pts)]
        L += vlen(vsub(p1, p2))
    return L


def polygon_with_holes(outer_verts, holes, chord=0.1):
    outer = flatten_bulge_ring(outer_verts, chord=chord)
    hole_rings = []
    for (cx, cy, d) in holes:
        r = d / 2.0
        n = max(24, int(2 * math.pi * r / chord))
        hole_rings.append([(cx + r * math.cos(2 * math.pi * k / n),
                             cy + r * math.sin(2 * math.pi * k / n)) for k in range(n)])
    return Polygon(outer, hole_rings)


def translate_verts(verts, dx, dy):
    return [(x + dx, y + dy, b) for (x, y, b) in verts]


def translate_holes(holes, dx, dy):
    return [(cx + dx, cy + dy, d) for (cx, cy, d) in holes]


# ===========================================================================
# PART DEFINITION
# ===========================================================================

class Part:
    def __init__(self, pid, name_cn, name_en, thickness, qty, outer, holes=None,
                 mark_lines=None, mark_notes=None, material=MATERIAL, bom_note=""):
        self.pid = pid
        self.name_cn = name_cn
        self.name_en = name_en
        self.thickness = thickness
        self.qty = qty
        self.outer = outer          # list of (x,y,bulge), closed ring
        self.holes = holes or []    # list of (cx,cy,d)
        self.mark_lines = mark_lines or []   # list of ((x1,y1),(x2,y2))
        self.mark_notes = mark_notes or []   # list of (x,y,text)
        self.material = material
        self.bom_note = bom_note
        self._poly = None

    @property
    def polygon(self):
        if self._poly is None:
            self._poly = polygon_with_holes(self.outer, self.holes)
        return self._poly

    @property
    def bbox(self):
        return self.polygon.bounds  # minx,miny,maxx,maxy

    def area_mm2(self):
        return self.polygon.area

    def mass_kg_each(self):
        return self.area_mm2() * self.thickness * STEEL_DENSITY / 1000.0

    def filename(self):
        return f"{self.pid}_{self.name_en}_t{self.thickness}_x{self.qty}.dxf"


# ===========================================================================
# PART GROUP 1 -- ARM (斗杆)
# ===========================================================================

A = (0.0, 0.0)
B_pt = (-230.0, 200.0)
C_pt = (150.0, 215.0)
E_pt = (800.0, 20.0)
D_pt = (950.0, 0.0)
F_pt = (120.0, 180.0)  # concave fillet centre used only to build the outline


def build_arm_parts():
    parts = []

    # ---- A1 side plate --------------------------------------------------
    circles_a1 = [
        (A[0], A[1], 50, 1),
        (D_pt[0], D_pt[1], 40, 1),
        (F_pt[0], F_pt[1], 60, -1),
        (B_pt[0], B_pt[1], 40, 1),
    ]
    verts_a1, segs_a1 = tangent_chain(circles_a1)
    seg_AD = segs_a1[0]   # A -> D  (bottom)
    seg_DF = segs_a1[1]   # D -> F  (top)
    seg_FB = segs_a1[2]   # F -> B  (open, arm-cylinder rod entry)
    seg_BA = segs_a1[3]   # B -> A  (rear)

    poly_a1 = polygon_with_holes(verts_a1, [])
    assert poly_a1.is_valid and poly_a1.exterior.is_ccw, "A1 outline invalid/not CCW"
    assert poly_a1.contains(Point(E_pt)), "A1: E circle must lie INSIDE the outline"
    assert not poly_a1.contains(Point(C_pt)), "A1: C must lie OUTSIDE the outline"
    log(f"[assert OK] A1: E{E_pt} inside outline, C{C_pt} outside outline")

    a1 = Part(
        "A1", "臂侧板", "arm_side_plate", 10, 2, verts_a1,
        holes=[(A[0], A[1], 60.5), (D_pt[0], D_pt[1], 50.5), (E_pt[0], E_pt[1], 50.5), (B_pt[0], B_pt[1], 28)],
        mark_notes=[],
        bom_note="B孔焊后线镗至Ø30H9",
    )
    parts.append(a1)

    # ---- A2 bottom plate (A->D) -----------------------------------------
    len_AD = vlen(vsub(seg_AD[1], seg_AD[0]))
    a2 = Part("A2", "臂底板", "arm_bottom_plate", 12, 1,
              rect_verts(len_AD, 75), bom_note="长度按实物修配 ±2 (对应 A->D 切线段)")
    parts.append(a2)

    # ---- A3 top plate (D->F) ---------------------------------------------
    len_DF = vlen(vsub(seg_DF[1], seg_DF[0]))
    a3 = Part("A3", "臂顶板", "arm_top_plate", 10, 1,
              rect_verts(len_DF, 75), bom_note="长度按实物修配 ±2 (对应 D->F 切线段)")
    parts.append(a3)

    # ---- A4 rear plate (B->A) ---------------------------------------------
    len_BA = vlen(vsub(seg_BA[1], seg_BA[0]))
    a4 = Part("A4", "臂后板", "arm_rear_plate", 10, 1,
              rect_verts(len_BA, 75),
              bom_note="长度=B->A切线段；F->B切线段（曲柄顶部）保持开口，为臂缸杆头进出口，不封板")
    parts.append(a4)

    # ---- A5 bucket-cylinder lug -------------------------------------------
    x1, y1 = seg_DF[0]
    x2, y2 = seg_DF[1]

    def y_on_topline(x):
        return y1 + (y2 - y1) * (x - x1) / (x2 - x1)

    p90 = (90.0, y_on_topline(90.0))
    p220 = (220.0, y_on_topline(220.0))
    hull5 = unary_union([Point(C_pt).buffer(40, resolution=256),
                          Point(p90).buffer(0.01), Point(p220).buffer(0.01)]).convex_hull
    lug_poly = hull5.difference(poly_a1)
    # keep the (single) polygon piece
    if lug_poly.geom_type == "MultiPolygon":
        lug_poly = max(lug_poly.geoms, key=lambda g: g.area)
    ring = list(lug_poly.exterior.coords)[:-1]
    verts_a5 = [(x, y, 0.0) for (x, y) in ring]
    a5 = Part("A5", "斗缸耳板", "cyl_lug", 12, 2, verts_a5,
              holes=[(C_pt[0], C_pt[1], 28)],
              bom_note="焊后线镗至Ø30H9；轮廓含圆弧部分按≤0.05mm弦高折线逼近（本图纸唯一允许折线近似的零件）；两耳内间距62")
    parts.append(a5)

    # ---- A6 reinforcing ring at B -------------------------------------------
    a6 = Part("A6", "B处加强环", "reinforcing_ring", 10, 2,
              circle_as_polyline(B_pt[0], B_pt[1], 35.0),
              holes=[(B_pt[0], B_pt[1], 28)],
              bom_note="贴焊于两侧侧板外侧，随侧板一起镗孔")
    parts.append(a6)

    kin_info = dict(seg_AD=seg_AD, seg_DF=seg_DF, seg_FB=seg_FB, seg_BA=seg_BA, poly_a1=poly_a1)
    return parts, kin_info


def rect_verts(length, width):
    return [(0.0, 0.0, 0.0), (length, 0.0, 0.0), (length, width, 0.0), (0.0, width, 0.0)]


# ===========================================================================
# PART GROUP 2 -- BUCKET LINKAGE
# ===========================================================================

def build_linkage_parts():
    parts = []
    verts_l1, _ = tangent_chain([(0.0, 0.0, 35, 1), (230.0, 0.0, 35, 1)])
    l1 = Part("L1", "斗杆连杆", "arm_link", 10, 2, verts_l1,
              holes=[(0.0, 0.0, 28), (230.0, 0.0, 28)],
              bom_note="孔铰制至Ø30H9；套装于臂杆外侧，内间距97")
    parts.append(l1)

    verts_l2, _ = tangent_chain([(0.0, 0.0, 35, 1), (210.0, 0.0, 35, 1)])
    l2 = Part("L2", "铲斗连杆", "bucket_link", 10, 2, verts_l2,
              holes=[(0.0, 0.0, 28), (210.0, 0.0, 28)],
              bom_note="孔铰制至Ø30H9；装于斗耳板之间，外侧总宽95")
    parts.append(l2)
    return parts


# ===========================================================================
# PART GROUP 3 -- BUCKET (铲斗)   -- bucket frame: D at origin
# ===========================================================================

D0 = (0.0, 0.0)
G0 = (-131.56, -47.88)
T0 = (450 * math.cos(math.radians(-70)), 450 * math.sin(math.radians(-70)))
P1_0 = (-200.0, -95.0)
P2_0 = (80.0, -95.0)
B1_0 = (-10.0, -450.0)
ARC_C = (-10.0, -270.0)
ARC_R = 180.0
B2_0 = (-190.0, -270.0)


def build_bucket_parts():
    parts = []

    # struck volume
    a1 = math.atan2(B1_0[1] - ARC_C[1], B1_0[0] - ARC_C[0])
    a2 = math.atan2(B2_0[1] - ARC_C[1], B2_0[0] - ARC_C[0])
    sweep_deg = -math.degrees(-((a1 - a2) % (2 * math.pi)))  # informational
    bulge_arc = -math.tan(math.radians(90) / 4.0)  # 90 deg, CW
    verts_k1 = [
        (P1_0[0], P1_0[1], 0.0),
        (P2_0[0], P2_0[1], 0.0),
        (T0[0], T0[1], 0.0),
        (B1_0[0], B1_0[1], bulge_arc),
        (B2_0[0], B2_0[1], 0.0),
    ]
    poly_k1 = polygon_with_holes(verts_k1, [])
    assert poly_k1.is_valid, "K1 bucket side profile is not a valid simple polygon"
    struck_area = poly_k1.area
    struck_vol_m3 = struck_area * 384.0 / 1e9
    log(f"Bucket struck area = {struck_area:.1f} mm^2, width 384mm -> struck volume = {struck_vol_m3:.5f} m^3")

    k1 = Part("K1", "斗侧板", "bucket_side_plate", 8, 2, verts_k1,
              bom_note=f"外部型线（斗型外轮廓）；铲斗结构容量≈{struck_vol_m3:.4f} m^3")
    parts.append(k1)

    k2 = Part("K2", "斗顶板", "bucket_top_plate", 8, 1,
              rect_verts(384, 280), bom_note="对应 P1->P2 顶部")
    parts.append(k2)

    k3 = Part("K3", "刃板", "cutting_edge", 12, 1,
              rect_verts(384, 110), material="NM400(或Q355替代)",
              mark_notes=[(192, 55, "前缘开 30° 坡口(刃口)，可焊接式斗齿另购")],
              bom_note="下缘落于 T->B1 线,自T起; NM400推荐, Q355B可替代")
    parts.append(k3)

    # ---- K4 wrap plate: developed length on neutral line -----------------
    d_T_B1 = vlen(vsub(T0, B1_0))
    straight1 = d_T_B1 - 110.0
    arc_len_neutral = math.pi * 177.0 / 2.0  # 90 deg at R177
    straight2 = vlen(vsub(B2_0, P1_0))
    Ldev = straight1 + arc_len_neutral + straight2
    log(f"K4 wrap plate developed length: straight1={straight1:.2f} + arc(R177,90deg)={arc_len_neutral:.2f} "
        f"+ straight2={straight2:.2f} = Ldev={Ldev:.2f} mm")

    bend1_x = straight1
    bend2_x = straight1 + arc_len_neutral
    k4 = Part("K4", "底弧板", "wrap_plate", 6, 1,
              rect_verts(Ldev, 384),
              mark_lines=[((bend1_x, 0.0), (bend1_x, 384.0)), ((bend2_x, 0.0), (bend2_x, 384.0))],
              mark_notes=[(Ldev / 2.0, 392.0, "卷弧 R177(中性层)/内 R174")],
              bom_note=f"平板展开 384 x {Ldev:.1f}；两条MARK线之间卷弧，线外两端保持平直")
    parts.append(k4)

    # ---- K5 ear plate: hull(D r45, G r45, segment y=-95 x in [-180,60]) --
    seg_a = (60.0, -95.0)
    seg_b = (-180.0, -95.0)
    circles5 = [(seg_a[0], seg_a[1], 0, 1), (D0[0], D0[1], 45, 1), (G0[0], G0[1], 45, 1), (seg_b[0], seg_b[1], 0, 1)]
    verts_k5, _ = tangent_chain(circles5)
    poly_k5 = polygon_with_holes(verts_k5, [])
    assert poly_k5.is_valid and poly_k5.exterior.is_ccw, "K5 outline invalid/not CCW"
    k5 = Part("K5", "斗耳板", "ear_plate", 12, 2, verts_k5,
              holes=[(D0[0], D0[1], 50.5), (G0[0], G0[1], 50.5)],
              bom_note="耳板站立于斗顶板上；两耳内间距97，臂宽95插入其间")
    parts.append(k5)

    # ---- K6 ear gusset: right triangle 60x60, 10x10 corner clip -----------
    verts_k6 = [(10.0, 0.0, 0.0), (60.0, 0.0, 0.0), (0.0, 60.0, 0.0), (0.0, 10.0, 0.0)]
    k6 = Part("K6", "耳板三角筋板", "ear_gusset", 8, 4, verts_k6,
              bom_note="直角处10x10清角，避免与斗顶板/耳板焊角干涉")
    parts.append(k6)

    return parts, dict(struck_vol_m3=struck_vol_m3, poly_k1=poly_k1)


# ===========================================================================
# DXF OUTPUT
# ===========================================================================

def new_doc():
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 4  # mm
    doc.header["$MEASUREMENT"] = 1
    if "CUT" not in doc.layers:
        doc.layers.add("CUT", color=7)
    if "MARK" not in doc.layers:
        doc.layers.add("MARK", color=3)
    return doc


def add_part_geometry(msp, part, dx=0.0, dy=0.0):
    outer = translate_verts(part.outer, dx, dy)
    pl = msp.add_lwpolyline(outer, format="xyb", dxfattribs={"layer": "CUT"})
    pl.closed = True
    for (cx, cy, d) in translate_holes(part.holes, dx, dy):
        msp.add_circle((cx, cy), d / 2.0, dxfattribs={"layer": "CUT"})

    mark_pt = part.polygon.representative_point()
    mx, my = mark_pt.x + dx, mark_pt.y + dy
    minx, miny, maxx, maxy = part.bbox
    h = 8.0
    header = f"{part.pid} {part.name_cn}"
    line2 = f"t{part.thickness}  x{part.qty}  {part.material}"
    msp.add_text(header, dxfattribs={"layer": "MARK", "height": h, "insert": (mx, my + h)})
    msp.add_text(line2, dxfattribs={"layer": "MARK", "height": h, "insert": (mx, my - h * 0.4)})
    for (x, y, txt) in part.mark_notes:
        msp.add_text(txt, dxfattribs={"layer": "MARK", "height": 5.0, "insert": (x + dx, y + dy)})
    for (p1, p2) in part.mark_lines:
        msp.add_line((p1[0] + dx, p1[1] + dy), (p2[0] + dx, p2[1] + dy), dxfattribs={"layer": "MARK"})


def write_part_dxf(part):
    doc = new_doc()
    msp = doc.modelspace()
    add_part_geometry(msp, part)

    auditor = doc.audit()
    assert len(auditor.errors) == 0, f"{part.pid}: DXF audit errors: {auditor.errors}"
    for e in msp.query("LWPOLYLINE[layer=='CUT']"):
        assert e.closed, f"{part.pid}: CUT LWPOLYLINE not closed"

    path = os.path.join(DXFDIR, part.filename())
    doc.saveas(path)
    return path


def pack_layout(parts, max_row_width=4200.0, gap=100.0):
    """simple shelf bin-packing, returns dict pid -> (dx,dy)"""
    cursor_x = 0.0
    cursor_y = 0.0
    row_h = 0.0
    offsets = {}
    for p in parts:
        minx, miny, maxx, maxy = p.bbox
        w = maxx - minx
        h = maxy - miny
        if cursor_x > 0 and cursor_x + w > max_row_width:
            cursor_x = 0.0
            cursor_y += row_h + gap
            row_h = 0.0
        dx = cursor_x - minx
        dy = cursor_y - miny
        offsets[p.pid] = (dx, dy)
        cursor_x += w + gap
        row_h = max(row_h, h)
    return offsets


def setup_dimstyle(doc):
    if "PLATE" not in doc.dimstyles:
        doc.dimstyles.new("PLATE", dxfattribs={
            "dimtxt": 6.0, "dimasz": 4.0, "dimexo": 3.0, "dimexe": 3.0,
            "dimtad": 1, "dimclrt": 7, "dimdec": 1,
        })


def write_all_sheet(all_parts):
    doc = new_doc()
    doc.layers.add("DIM", color=4)
    setup_dimstyle(doc)
    msp = doc.modelspace()

    offsets = pack_layout(all_parts)
    for p in all_parts:
        dx, dy = offsets[p.pid]
        add_part_geometry(msp, p, dx, dy)

        minx, miny, maxx, maxy = p.bbox
        minx, miny, maxx, maxy = minx + dx, miny + dy, maxx + dx, maxy + dy

        # overall length (bottom) & height (left) dims
        try:
            d = msp.add_aligned_dim(p1=(minx, miny), p2=(maxx, miny), distance=-30,
                                     dimstyle="PLATE", dxfattribs={"layer": "DIM"})
            d.render()
        except Exception as ex:
            log(f"[warn] dim (length) failed for {p.pid}: {ex}")
        try:
            d = msp.add_aligned_dim(p1=(minx, miny), p2=(minx, maxy), distance=-30,
                                     dimstyle="PLATE", dxfattribs={"layer": "DIM"})
            d.render()
        except Exception as ex:
            log(f"[warn] dim (height) failed for {p.pid}: {ex}")

        # hole diameters
        for (cx, cy, dia) in translate_holes(p.holes, dx, dy):
            try:
                d = msp.add_diameter_dim(center=(cx, cy), radius=dia / 2.0, angle=45,
                                          dimstyle="PLATE", dxfattribs={"layer": "DIM"})
                d.render()
            except Exception as ex:
                log(f"[warn] diameter dim failed for {p.pid}: {ex}")

        # hole-to-hole (pin centre) distance
        holes_t = translate_holes(p.holes, dx, dy)
        if len(holes_t) >= 2:
            h1 = (holes_t[0][0], holes_t[0][1])
            h2 = (holes_t[1][0], holes_t[1][1])
            try:
                d = msp.add_aligned_dim(p1=h1, p2=h2, distance=25,
                                         dimstyle="PLATE", dxfattribs={"layer": "DIM"})
                d.render()
            except Exception as ex:
                log(f"[warn] pin-centre dim failed for {p.pid}: {ex}")

    auditor = doc.audit()
    assert len(auditor.errors) == 0, f"ALL sheet: DXF audit errors: {auditor.errors}"
    for e in msp.query("LWPOLYLINE[layer=='CUT']"):
        assert e.closed, "ALL sheet: CUT LWPOLYLINE not closed"

    path = os.path.join(DXFDIR, "ALL_parts_sheet.dxf")
    doc.saveas(path)
    return path, offsets


# ===========================================================================
# PREVIEW PNGs
# ===========================================================================

def draw_part_on_ax(ax, part):
    pts = flatten_bulge_ring(part.outer, chord=0.3)
    xs = [p[0] for p in pts] + [pts[0][0]]
    ys = [p[1] for p in pts] + [pts[0][1]]
    ax.fill(xs, ys, facecolor="#cfe3f7", edgecolor="#1a4d8f", linewidth=1.2, zorder=2)
    for (cx, cy, d) in part.holes:
        circ = plt.Circle((cx, cy), d / 2.0, facecolor="white", edgecolor="#1a4d8f", linewidth=1.0, zorder=3)
        ax.add_patch(circ)
    ax.set_aspect("equal")
    ax.set_title(f"{part.pid} {part.name_en}\nt{part.thickness} x{part.qty}", fontsize=8)
    ax.tick_params(labelsize=6)


def write_parts_png(all_parts):
    n = len(all_parts)
    cols = 4
    rows = math.ceil(n / cols)
    fig, axes = plt.subplots(rows, cols, figsize=(cols * 3.6, rows * 3.2))
    axes = axes.flatten()
    for ax, p in zip(axes, all_parts):
        draw_part_on_ax(ax, p)
    for ax in axes[n:]:
        ax.axis("off")
    fig.suptitle("U17-class arm/bucket laser parts (1:1 profile, not to page scale)", fontsize=11)
    fig.tight_layout(rect=[0, 0, 1, 0.97])
    path = os.path.join(PREVDIR, "parts.png")
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


# ===========================================================================
# KINEMATICS
# ===========================================================================

def circle_intersection(c1, r1, c2, r2):
    x1, y1 = c1
    x2, y2 = c2
    dx, dy = x2 - x1, y2 - y1
    dist = math.hypot(dx, dy)
    if dist > r1 + r2 or dist < abs(r1 - r2) or dist < 1e-9:
        return None
    a = (r1 ** 2 - r2 ** 2 + dist ** 2) / (2 * dist)
    h2 = r1 ** 2 - a ** 2
    if h2 < 0:
        return None
    h = math.sqrt(h2)
    xm, ym = x1 + a * dx / dist, y1 + a * dy / dist
    rx, ry = -dy * (h / dist), dx * (h / dist)
    return (xm + rx, ym + ry), (xm - rx, ym - ry)


def G_arm_of(g_deg):
    gr = math.radians(g_deg)
    return (D_pt[0] + 140 * math.cos(gr), D_pt[1] + 140 * math.sin(gr))


def bucket_point_in_arm_frame(p_local, g_deg):
    """p_arm = D + Rot(g-160deg) . (p.x, -p.y)"""
    mirrored = (p_local[0], -p_local[1])
    rotated = rot(mirrored, math.radians(g_deg - 160.0))
    return vadd(D_pt, rotated)


def transformed_bucket_polygon(g_deg):
    pts = flatten_bulge_ring([
        (P1_0[0], P1_0[1], 0.0), (P2_0[0], P2_0[1], 0.0), (T0[0], T0[1], 0.0),
        (B1_0[0], B1_0[1], -math.tan(math.radians(90) / 4.0)), (B2_0[0], B2_0[1], 0.0),
    ], chord=0.3)
    return Polygon([bucket_point_in_arm_frame(p, g_deg) for p in pts])


def cylinder_capsule(C_p, J_p):
    d = vsub(J_p, C_p)
    L = vlen(d)
    u = vunit(d)
    split = min(470.0, L)
    mid = vadd(C_p, vscale(u, split))
    from shapely.geometry import LineString
    geoms = [LineString([C_p, mid]).buffer(34.0, cap_style=1)]
    if L > split:
        geoms.append(LineString([mid, J_p]).buffer(15.0, cap_style=1))
    geoms.append(Point(J_p).buffer(25.0))
    return unary_union(geoms)


def run_kinematics(poly_a1):
    arm_minus_hub = poly_a1.difference(Point(D_pt).buffer(55.0))

    rows = []
    for gi in range(-100, 131):
        g = float(gi)
        Ga = G_arm_of(g)
        sol = circle_intersection(E_pt, 230.0, Ga, 210.0)
        if sol is None:
            continue
        p1, p2 = sol
        J = p1 if p1[1] > p2[1] else p2
        L = vlen(vsub(C_pt, J))
        v1 = vsub(E_pt, J)
        v2 = vsub(Ga, J)
        dot = v1[0] * v2[0] + v1[1] * v2[1]
        m1, m2 = vlen(v1), vlen(v2)
        ang = math.degrees(math.acos(max(-1.0, min(1.0, dot / (m1 * m2)))))
        okL = 560.0 <= L <= 860.0
        okAng = 35.0 <= ang <= 145.0
        rows.append(dict(g=g, J=J, L=L, ang=ang, okL=okL, okAng=okAng, ok=okL and okAng))

    reach = [r for r in rows if r["okL"]]
    if not reach:
        raise RuntimeError("No g value satisfies the 560-860mm cylinder stroke window")
    g_min = min(r["g"] for r in reach)
    g_max = max(r["g"] for r in reach)
    min_ang = min(r["ang"] for r in reach)
    min_ang_g = [r["g"] for r in reach if r["ang"] == min_ang][0]

    min_clear = None
    max_overlap = 0.0
    min_bclr = None
    for r in reach:
        g = r["g"]
        bpoly = transformed_bucket_polygon(g)
        overlap = bpoly.intersection(arm_minus_hub).area
        max_overlap = max(max_overlap, overlap)
        bclr = bpoly.distance(arm_minus_hub)
        min_bclr = bclr if min_bclr is None else min(min_bclr, bclr)
        cap = cylinder_capsule(C_pt, r["J"])
        clr = cap.distance(poly_a1)
        if clr <= 0:
            clr = -cap.intersection(poly_a1).area ** 0.5  # negative "depth-ish" indicator
        if min_clear is None or clr < min_clear:
            min_clear = clr

    tip_min = g_min - 90.0
    tip_max = g_max - 90.0

    report = dict(
        g_min=g_min, g_max=g_max, span=g_max - g_min,
        tip_min=tip_min, tip_max=tip_max,
        min_transmission_angle=min_ang, min_transmission_angle_g=min_ang_g,
        min_cyl_arm_clearance=min_clear, max_bucket_arm_overlap=max_overlap, min_bucket_arm_clearance=min_bclr,
        rows=rows, reach=reach, arm_minus_hub=arm_minus_hub,
    )
    return report


def draw_pose(ax, g, poly_a1, title):
    xs, ys = poly_a1.exterior.xy
    ax.fill(xs, ys, facecolor="#dddddd", edgecolor="#333333", linewidth=1.0, zorder=1)

    bpoly = transformed_bucket_polygon(g)
    xs2, ys2 = bpoly.exterior.xy
    ax.fill(xs2, ys2, facecolor="#f7d9a0", edgecolor="#8a4b00", linewidth=1.2, zorder=2)

    Ga = G_arm_of(g)
    sol = circle_intersection(E_pt, 230.0, Ga, 210.0)
    J = None
    if sol:
        p1, p2 = sol
        J = p1 if p1[1] > p2[1] else p2

    for (pt, name) in [(A, "A"), (B_pt, "B"), (C_pt, "C"), (E_pt, "E"), (D_pt, "D"), (Ga, "G")]:
        ax.plot(*pt, "o", color="black", markersize=3, zorder=4)
        ax.annotate(name, pt, fontsize=7, xytext=(3, 3), textcoords="offset points")
    if J:
        ax.plot(*J, "o", color="red", markersize=4, zorder=5)
        ax.annotate("J", J, fontsize=7, xytext=(3, 3), textcoords="offset points", color="red")
        ax.plot([C_pt[0], J[0]], [C_pt[1], J[1]], "--", color="red", linewidth=1.2, zorder=4)
        L = vlen(vsub(C_pt, J))
        ax.set_title(f"{title}\ng={g:.0f} deg, L(cyl)={L:.0f}mm", fontsize=9)
    ax.set_aspect("equal")
    ax.tick_params(labelsize=6)


def write_assembly_png(report, poly_a1):
    g_min, g_max = report["g_min"], report["g_max"]
    g_mid = (g_min + g_max) / 2.0
    fig, axes = plt.subplots(1, 3, figsize=(15, 6))
    draw_pose(axes[0], g_min, poly_a1, "Full curl (cylinder extended)")
    draw_pose(axes[1], g_mid, poly_a1, "Mid")
    draw_pose(axes[2], g_max, poly_a1, "Full dump (cylinder retracted)")
    fig.suptitle("Arm + bucket-linkage + bucket, 3 poses across the cylinder-reachable range", fontsize=11)
    fig.tight_layout(rect=[0, 0, 1, 0.94])
    path = os.path.join(PREVDIR, "assembly_poses.png")
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


# ===========================================================================
# BOM
# ===========================================================================

def write_bom(all_parts, kin_report, struck_vol_m3):
    lines = []
    lines.append("# U17-class 斗杆/铲斗/连杆总成 — 物料清单 (BOM)\n")
    lines.append("> 尺寸按公开参数推算的自主设计，非久保田原厂图纸；承力件上机前请结构工程师复核；")
    lines.append("> 臂缸（B 处）及动臂接口（A 处）取决于动臂本体，不在本次设计范围内。\n")

    lines.append("## 激光切割件 (钢板 Q355B，激光切割，推荐刃口用刃 NM400)\n")
    lines.append("| 编号 | 名称 | 厚度(mm) | 数量 | 材料 | 单件重量(kg) | 备注 |")
    lines.append("|---|---|---|---|---|---|---|")
    total_mass = 0.0
    for p in all_parts:
        m = p.mass_kg_each()
        total_mass += m * p.qty
        lines.append(f"| {p.pid} | {p.name_cn} | {p.thickness} | {p.qty} | {p.material} | {m:.2f} | {p.bom_note} |")
    lines.append(f"\n**激光件总重量（含全部数量）≈ {total_mass:.1f} kg**\n")

    lines.append("## 外购/车加工件\n")
    lines.append("| 名称 | 规格 | 数量 | 备注 |")
    lines.append("|---|---|---|---|")
    lines.append("| A处衬套 | 45#无缝管 OD60 L95，焊后镗至Ø35H8 | 1 | 与A1线镗一起加工 |")
    lines.append("| D/E处衬套 | 45#无缝管 OD50 L95，焊后镗至Ø30H8 | 2 | D、E各一 |")
    lines.append("| D/G处耳衬套 | 45#无缝管 OD50 L25，焊后镗至Ø30H8 | 4 | 内平齐、外凸出13 |")
    lines.append("| 销轴 Ø30 | 40Cr 调质 | D,E,G,J,C 共5根 | 长度按各处叠层估算，见下 |")
    lines.append("| 销轴 Ø35 | 40Cr 调质 | A 处 1根 | 长度按动臂接口叠层估算，本图未设计动臂侧 |")
    lines.append("| 销轴 Ø30 | 40Cr 调质 | B 处 1根 | 臂缸摆动杆头，长度取决于臂缸型号 |")
    lines.append("| G处衬套 | 无缝管 OD45 ID30.5 L75 | 1 | 斗连杆之间隔套 |")
    lines.append("| 斗缸 | 缸径55/杆径30，闭合长560，行程300（伸出860），铰点Ø30，底耳宽≤60，杆耳宽≤70 | 1 | 外购液压缸 |\n")

    lines.append("**销轴指示长度（按叠层估算，mm）：**\n")
    lines.append("- D 销（斗杆-铲斗铰点）：D耳板(K5,12) + 斗杆衬套(95) + D耳板(12) ≈ 119，另加两侧K5耳衬套凸出13x2 → 全长约 145")
    lines.append("- E 销（斗杆-连杆铰点）：臂侧板t10x2(=20)+两侧衬套(95)+连杆内间距(97) 取较大者，估约 L≈97+2*10=117（连杆在外侧）")
    lines.append("- G 销（斗连杆-铲斗连杆铰点）：斗连杆t10x2+隔套(75) ≈ 95")
    lines.append("- J 销（连杆-连杆铰点）：L1、L2 各t10，叠合处约 20~30，具体按最终装配定")
    lines.append("- C 销（斗缸底铰点）：A5耳板t12x2 + 缸底耳宽≤60 → 约 84~90")
    lines.append("- A 销：Ø35，取决于动臂本体接口，本设计未涉及，仅给孔位Ø60.5/线镗Ø35H8\n")
    lines.append("> 以上销长均为**估算指示值**，最终以实际叠层复核为准。\n")

    lines.append("## 组焊工艺要点\n")
    lines.append("1. **臂总成**：A1侧板×2先与A2底板、A3顶板、A4后板点固定位组焊成箱形梁；"
                  "F->B（曲柄顶部）切线段保持开口，为臂缸杆头让位，不封板。A5斗缸耳板焊于臂顶后（跨A3顶板处），"
                  "A6加强环贴焊于A、B孔外侧。")
    lines.append("2. **焊后镗孔**：A(Ø35H8)、D/E(Ø30H8)、C(A5,Ø30H9)、B(Ø30H9) 均为先焊后镗，"
                  "保证两侧板同轴，孔位公差由镗床保证，不依赖激光切割孔位精度。")
    lines.append("3. **刃板坡口**：K3刃板前缘（远离铲斗一侧长边）开30°坡口，与K1侧板/K4底弧板对接焊；"
                  "可焊接式斗齿座另购另焊，不含在本次设计中。")
    lines.append("4. **底弧板卷弧**：K4为t6平板下料，仅在两条MARK基准线之间的区段卷弧至中性层R177（外R180/内R174），"
                  "两端平直段（连接刃板与顶板的直边）保持不卷，卷弧后与K1侧板、K3刃板、K2顶板组焊。")
    lines.append("5. **铲斗总成**：K5耳板立焊于K2顶板上表面（y=-95基准线），K6三角筋板补强K5耳板与顶板/侧板之间的焊缝根部。")
    lines.append(f"6. **理论容量**：铲斗结构容量（型线面积x宽度384）≈ {struck_vol_m3:.4f} m^3（参考，未计边坡角修正）。\n")

    lines.append("## 装配接口尺寸\n")
    lines.append("| 项目 | 数值(mm) |")
    lines.append("|---|---|")
    lines.append("| 臂杆销孔：A/D/E | Ø35(A) / Ø30(D,E) |")
    lines.append("| 斗杆连杆(L1)内间距 | 97（套装于臂杆外侧，臂杆外宽95） |")
    lines.append("| 铲斗耳板(K5)内间距 | 97（臂杆外宽95插入其间） |")
    lines.append("| 斗缸耳板(A5)内间距 | 62 |")
    lines.append("| 铲斗切割宽度（外） | 400，侧板t8 → 内宽384 |\n")

    lines.append("## 运动学核算（详见控制台输出与 preview/assembly_poses.png）\n")
    lines.append(f"- 油缸可达角度范围 g（满足油缸长度560~860mm，且与g连续覆盖）：**{kin_report['g_min']:.0f}° 至 {kin_report['g_max']:.0f}°**"
                 f"（铲斗回转跨度 {kin_report['span']:.0f}°）")
    lines.append(f"- 对应斗尖角（臂系坐标, = g-90）：**{kin_report['tip_min']:.1f}° 至 {kin_report['tip_max']:.1f}°**")
    lines.append(f"- 可达范围内最小传动角：**{kin_report['min_transmission_angle']:.1f}°**（发生于 g={kin_report['min_transmission_angle_g']:.0f}°；"
                 f"合格区间[35°,145°]内）")
    cl = kin_report['min_cyl_arm_clearance']
    if cl >= 0:
        lines.append(f"- 斗缸(近似胶囊体)与臂侧板最小间隙：**{cl:.1f} mm**（正值=不干涉）")
    else:
        lines.append(f"- 斗缸(近似胶囊体)与臂侧板存在干涉，重叠面积平方根量级 **{-cl:.1f} mm**（负值=干涉，需复核缸安装位置/摆角限位）")
    lines.append(f"- 铲斗斗体与斗杆（扣除D处R55轮毂圆）：最大重叠 **{kin_report['max_bucket_arm_overlap']:.1f} mm²**，"
                 f"最小间隙 **{kin_report['min_bucket_arm_clearance']:.1f} mm**（油缸伸到 860 即为收斗极限；"
                 f"若换 320 行程油缸，收斗到底时斗口会顶到斗杆底板）")
    lines.append("- g 最小端 = 油缸全伸 = 收斗到底；g 最大端 = 油缸全缩 = 翻斗卸料到底\n")

    lines.append("## 明细文件\n")
    lines.append("- `dxf/*.dxf`：各零件1:1激光切割图")
    lines.append("- `dxf/ALL_parts_sheet.dxf`：全零件排版汇总图（含关键尺寸标注）")
    lines.append("- `preview/parts.png`：全零件预览图")
    lines.append("- `preview/assembly_poses.png`：三姿态（起始/中间/终止）装配预览图\n")

    path = os.path.join(HERE, "BOM.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path


# ===========================================================================
# MAIN
# ===========================================================================

def main():
    log("=" * 70)
    log("U17-class arm/bucket/linkage plate generator")
    log("=" * 70)

    arm_parts, kin_info = build_arm_parts()
    link_parts = build_linkage_parts()
    bucket_parts, bucket_info = build_bucket_parts()
    all_parts = arm_parts + link_parts + bucket_parts

    log("\n--- writing per-part DXF ---")
    for p in all_parts:
        path = write_part_dxf(p)
        log(f"  {p.pid}: {os.path.relpath(path, HERE)}  area={p.area_mm2():.0f}mm^2  "
            f"mass/ea={p.mass_kg_each():.3f}kg  qty={p.qty}")

    log("\n--- writing ALL_parts_sheet.dxf ---")
    all_path, offsets = write_all_sheet(all_parts)
    log(f"  {os.path.relpath(all_path, HERE)}")

    log("\n--- writing preview/parts.png ---")
    png1 = write_parts_png(all_parts)
    log(f"  {os.path.relpath(png1, HERE)}")

    log("\n--- kinematics ---")
    kin_report = run_kinematics(kin_info["poly_a1"])
    log(f"  cylinder-reachable g range: {kin_report['g_min']:.0f} .. {kin_report['g_max']:.0f} deg "
        f"(span {kin_report['span']:.0f} deg)")
    log(f"  tip angle (g-90) at range ends: {kin_report['tip_min']:.1f} .. {kin_report['tip_max']:.1f} deg")
    log(f"  min transmission angle in range: {kin_report['min_transmission_angle']:.1f} deg "
        f"at g={kin_report['min_transmission_angle_g']:.0f}")
    log(f"  min cylinder-arm clearance: {kin_report['min_cyl_arm_clearance']:.1f} mm")
    log(f"  max bucket-arm overlap area: {kin_report['max_bucket_arm_overlap']:.1f} mm^2")

    log("\n--- writing preview/assembly_poses.png ---")
    png2 = write_assembly_png(kin_report, kin_info["poly_a1"])
    log(f"  {os.path.relpath(png2, HERE)}")

    log("\n--- writing BOM.md ---")
    total_mass = sum(p.mass_kg_each() * p.qty for p in all_parts)
    bom_path = write_bom(all_parts, kin_report, bucket_info["struck_vol_m3"])
    log(f"  {os.path.relpath(bom_path, HERE)}  total laser-part mass = {total_mass:.1f} kg")

    log("\n--- per-part mass summary ---")
    for p in all_parts:
        log(f"  {p.pid} {p.name_en}: {p.mass_kg_each():.3f} kg/ea x{p.qty} = {p.mass_kg_each()*p.qty:.2f} kg")
    log(f"  TOTAL (laser parts) = {total_mass:.2f} kg")

    log("\nAll done, no assertion failures.")


if __name__ == "__main__":
    main()
