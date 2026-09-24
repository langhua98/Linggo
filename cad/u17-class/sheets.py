#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sheets.py -- GB-style drawing sheets, one per weldment, in build order:
  01 铲斗 (bucket)   02 斗杆 + 连杆 (arm + links)   03 动臂 (boom)

Sheet layout (as requested): LEFT = assembly three views (主视图 / 俯视图 below /
左视图 to the right, first-angle projection, hidden-line removal from the
CadQuery solids), RIGHT = that weldment's flat laser parts in part-number order,
every part fully dimensioned (chain dims, hole Ø, arc R, bend lines) and, for
irregular outlines, a coordinate table.  Bottom band: 技术要求, 明细栏, 标题栏.

Model space is 1:1 mm.  A sheet at scale 1:S draws its frame S times paper
size; text heights are paper-mm × S and dimensions use DIMSCALE = S, so the
printed result is standard size.  Paper (A1/A0) and S are chosen automatically
as the largest drawing that fits.
"""

import math
import os

import ezdxf
import ezdxf.fonts.fonts as ezfonts
from ezdxf import bbox as ezbbox
from ezdxf.enums import TextEntityAlignment as TA
from ezdxf.addons.drawing import Frontend, RenderContext, pymupdf, layout, config

from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape
from OCP.HLRAlgo import HLRAlgo_Projector
from OCP.gp import gp_Ax2, gp_Pnt, gp_Dir
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_EDGE
from OCP.TopoDS import TopoDS
from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.GCPnts import GCPnts_TangentialDeflection

import geom as G

FONT = "wqy-zenhei.ttc"
PAPERS = {"A1": (841.0, 594.0), "A0": (1189.0, 841.0)}
SCALES = (2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 10.0)  # GB/T 14690 series
DATE = "2026-09-24"

_font_ready = False


def _ensure_font():
    global _font_ready
    if not _font_ready:
        ezfonts.font_manager.build(folders=["/usr/share/fonts/truetype/wqy"])
        _font_ready = True


# ===========================================================================
# document / primitives
# ===========================================================================

LAYERS = [  # name, linetype, lineweight (1/100 mm)
    ("OUTLINE", "Continuous", 50),
    ("HIDDEN", "GB_HIDDEN", 25),
    ("CENTER", "GB_CENTER", 18),
    ("DIM", "Continuous", 18),
    ("TEXT", "Continuous", 25),
    ("MARK", "GB_PHANTOM", 25),
    ("THIN", "Continuous", 18),
    ("FRAME", "Continuous", 70),
]


def new_doc(S):
    _ensure_font()
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 4
    doc.header["$MEASUREMENT"] = 1
    doc.header["$LTSCALE"] = S
    # GB/T 4457.4 style patterns in paper mm (scaled by LTSCALE = S)
    doc.linetypes.add("GB_HIDDEN", pattern=[5.0, 4.0, -1.0], description="虚线 __ __")
    doc.linetypes.add("GB_CENTER", pattern=[20.0, 15.0, -2.0, 1.0, -2.0], description="点划线 ___ . ___")
    doc.linetypes.add("GB_PHANTOM", pattern=[23.0, 15.0, -2.0, 1.0, -2.0, 1.0, -2.0],
                      description="双点划线 ___ . . ___")
    doc.header["$LWDISPLAY"] = 1
    doc.styles.add("CJK", font=FONT)
    for name, lt, lw in LAYERS:
        doc.layers.add(name, linetype=lt, lineweight=lw, color=7)
    doc.dimstyles.new("GB", dxfattribs={
        # paper-mm values; DIMSCALE blows them up to model size
        "dimtxt": 2.5, "dimasz": 2.5, "dimexo": 1.0, "dimexe": 1.5, "dimgap": 0.8,
        "dimtad": 1, "dimtih": 0, "dimtoh": 0, "dimdec": 1, "dimzin": 8,
        "dimdsep": ord("."), "dimscale": S, "dimtxsty": "CJK",
        "dimlwd": 18, "dimlwe": 18, "dimtmove": 0,
    })
    return doc


class Pen:
    """Drawing helper bound to a sheet (msp, scale S) and a local offset."""

    def __init__(self, msp, S, dx=0.0, dy=0.0):
        self.msp, self.S, self.dx, self.dy = msp, S, dx, dy

    def p(self, pt):
        return (pt[0] + self.dx, pt[1] + self.dy)

    # ---- geometry ------------------------------------------------------
    def poly(self, pts, layer="OUTLINE", close=False):
        if len(pts) < 2:
            return
        self.msp.add_lwpolyline([self.p(q) for q in pts], close=close, dxfattribs={"layer": layer})

    def bulge_poly(self, verts, layer="OUTLINE"):
        self.msp.add_lwpolyline([(x + self.dx, y + self.dy, 0, 0, b) for (x, y, b) in verts],
                                format="xyseb", close=True, dxfattribs={"layer": layer})

    def line(self, a, b, layer="OUTLINE"):
        self.msp.add_line(self.p(a), self.p(b), dxfattribs={"layer": layer})

    def circle(self, c, r, layer="OUTLINE"):
        self.msp.add_circle(self.p(c), r, dxfattribs={"layer": layer})

    def center_cross(self, c, r):
        e = r + 3 * self.S
        self.line((c[0] - e, c[1]), (c[0] + e, c[1]), "CENTER")
        self.line((c[0], c[1] - e), (c[0], c[1] + e), "CENTER")

    # ---- text ------------------------------------------------------------
    def text(self, s, pos, h=3.5, align="L", layer="TEXT", rot=0.0):
        amap = {"L": TA.BOTTOM_LEFT, "C": TA.BOTTOM_CENTER, "R": TA.BOTTOM_RIGHT,
                "MC": TA.MIDDLE_CENTER, "ML": TA.MIDDLE_LEFT, "MR": TA.MIDDLE_RIGHT,
                "TL": TA.TOP_LEFT}
        t = self.msp.add_text(s, dxfattribs={"height": h * self.S, "style": "CJK", "layer": layer,
                                              "rotation": rot})
        t.set_placement(self.p(pos), align=amap[align])
        return t

    # ---- dimensions (all points local) -----------------------------------
    def hdim(self, a, b, y, text="<>"):
        if abs(a[0] - b[0]) < 0.05:
            return
        self.msp.add_linear_dim(base=self.p((a[0], y)), p1=self.p(a), p2=self.p(b), angle=0,
                                dimstyle="GB", text=text, dxfattribs={"layer": "DIM"}).render()

    def vdim(self, a, b, x, text="<>"):
        if abs(a[1] - b[1]) < 0.05:
            return
        self.msp.add_linear_dim(base=self.p((x, a[1])), p1=self.p(a), p2=self.p(b), angle=90,
                                dimstyle="GB", text=text, dxfattribs={"layer": "DIM"}).render()

    def adim(self, a, b, dist, text="<>"):
        if (b[0], b[1]) < (a[0], a[1]):
            a, b, dist = b, a, -dist
        self.msp.add_aligned_dim(p1=self.p(a), p2=self.p(b), distance=dist * self.S, dimstyle="GB",
                                 text=text, dxfattribs={"layer": "DIM"}).render()

    def dia(self, c, r, ang, text="<>"):
        self.msp.add_diameter_dim(center=self.p(c), radius=r, angle=ang, dimstyle="GB", text=text,
                                  override={"dimtofl": 1}, dxfattribs={"layer": "DIM"}).render()

    def rad(self, c, r, ang, text="<>"):
        loc = (c[0] + (r + 12 * self.S) * math.cos(math.radians(ang)),
               c[1] + (r + 12 * self.S) * math.sin(math.radians(ang)))
        self.msp.add_radius_dim(center=self.p(c), radius=r, location=self.p(loc), dimstyle="GB",
                                text=text, dxfattribs={"layer": "DIM"}).render()

    def ang(self, center, p1, p2, r, text="<>"):
        a1 = math.atan2(p1[1] - center[1], p1[0] - center[0])
        a2 = math.atan2(p2[1] - center[1], p2[0] - center[0])
        am = (a1 + a2) / 2.0
        if abs(a2 - a1) > math.pi:
            am += math.pi
        base = (center[0] + r * math.cos(am), center[1] + r * math.sin(am))
        self.msp.add_angular_dim_3p(base=self.p(base), center=self.p(center), p1=self.p(p1),
                                    p2=self.p(p2), dimstyle="GB", text=text,
                                    dxfattribs={"layer": "DIM"}).render()

    def leader(self, tip, knee, s, h=2.5):
        """Straight leader with a horizontal shoulder and text on it."""
        d = 1 if knee[0] >= tip[0] else -1
        end = (knee[0] + d * (len(s) * 0.9 + 1) * h * self.S, knee[1])
        self.msp.add_lwpolyline([self.p(tip), self.p(knee), self.p(end)], dxfattribs={"layer": "DIM"})
        # arrow dot at the tip
        self.msp.add_circle(self.p(tip), 0.6 * self.S, dxfattribs={"layer": "DIM"})
        self.text(s, (knee[0] + d * 1 * self.S, knee[1] + 0.8 * self.S), h, "L" if d > 0 else "R", "DIM")

    # ---- chains ------------------------------------------------------------
    def hchain(self, xs, y_feat, y, text_fmt=None):
        """Continuous horizontal dims through sorted x positions (dedup <0.5 mm).
        y_feat: function x -> feature y (extension-line origin)."""
        xs = _dedup(sorted(xs))
        for a, b in zip(xs, xs[1:]):
            self.hdim((a, y_feat(a)), (b, y_feat(b)), y)

    def vchain(self, ys, x_feat, x):
        ys = _dedup(sorted(ys))
        for a, b in zip(ys, ys[1:]):
            self.vdim((x_feat(a), a), (x_feat(b), b), x)


def _dedup(vals, tol=0.5):
    out = []
    for v in vals:
        if not out or abs(v - out[-1]) > tol:
            out.append(v)
    return out


def fmt(v):
    s = f"{v:.1f}"
    return s[:-2] if s.endswith(".0") else s


# ===========================================================================
# hidden-line views
# ===========================================================================

VIEWS = {  # viewer on the +normal side; (normal, local x-direction)
    "front": ((0, 0, 1), (1, 0, 0)),    # local (X, Y)
    "top": ((0, 1, 0), (1, 0, 0)),      # local (X, -Z): +Z (front) at the bottom (first angle)
    "left": ((-1, 0, 0), (0, 0, 1)),    # local (Z, Y): seen from the left, placed right
}


def _edges(comp, defl):
    out = []
    if comp.IsNull():
        return out
    ex = TopExp_Explorer(comp, TopAbs_EDGE)
    while ex.More():
        e = TopoDS.Edge_s(ex.Current())
        try:
            cur = BRepAdaptor_Curve(e)
            g = GCPnts_TangentialDeflection(cur, math.radians(4.0), defl)
            if g.NbPoints() >= 2:
                pts = [(g.Value(i).X(), g.Value(i).Y()) for i in range(1, g.NbPoints() + 1)]
                if math.dist(pts[0], pts[-1]) > 0.2 or len(pts) > 2:
                    out.append(pts)
        except Exception:
            pass
        ex.Next()
    return out


def hlr(solid, view, defl=0.05):
    n, xd = VIEWS[view]
    algo = HLRBRep_Algo()
    algo.Add(solid.val().wrapped)
    algo.Projector(HLRAlgo_Projector(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(*n), gp_Dir(*xd))))
    algo.Update()
    algo.Hide()
    h = HLRBRep_HLRToShape(algo)
    vis = _edges(h.VCompound(), defl) + _edges(h.OutLineVCompound(), defl)
    hid = _edges(h.HCompound(), defl) + _edges(h.OutLineHCompound(), defl) if view == "front" else []
    return vis, hid


def pl_bbox(pls):
    xs = [x for pl in pls for (x, _) in pl]
    ys = [y for pl in pls for (_, y) in pl]
    return min(xs), min(ys), max(xs), max(ys)


# ===========================================================================
# cells: something drawn at a local origin, measured before placement
# ===========================================================================

class Cell:
    def __init__(self, draw, title=None):
        self.draw = draw          # draw(pen)
        self.title = title
        self.bb = None            # (xmin, ymin, xmax, ymax) local, incl. dims/text

    def measure(self, S):
        doc = new_doc(S)
        msp = doc.modelspace()
        self.draw(Pen(msp, S))
        ext = ezbbox.extents(msp, fast=True)
        self.bb = (ext.extmin.x, ext.extmin.y, ext.extmax.x, ext.extmax.y)
        return self.bb

    @property
    def w(self):
        return self.bb[2] - self.bb[0]

    @property
    def h(self):
        return self.bb[3] - self.bb[1]


# ===========================================================================
# view cells (geometry + centre lines + dims supplied by a spec function)
# ===========================================================================

def view_cell(polys, title, dims_fn, centers=()):
    vis, hid = polys

    def draw(pen):
        for pl in hid:
            pen.poly(pl, "HIDDEN")
        for pl in vis:
            pen.poly(pl, "OUTLINE")
        for kind, a, b in centers:
            if kind == "cross":
                pen.center_cross(a, b)
            else:
                pen.line(a, b, "CENTER")
        bb = pl_bbox(vis)
        dims_fn(pen, bb)
        pen.text(title, ((bb[0] + bb[2]) / 2, bb[3] + 12 * pen.S), 5, "C")
    return Cell(draw, title)


# ===========================================================================
# flat-part cells
# ===========================================================================

def _label(part):
    return (f"{part.pid} {part.name_cn}  t{part.thickness} ×{part.qty}  {part.material}  "
            f"{part.mass_kg_each():.2f}kg/件")


def _circles_of_outline(verts):
    """Arc centres/radii of a bulge polyline: [(centre, r, mid_angle_deg)]."""
    out = []
    n = len(verts)
    for i in range(n):
        x, y, b = verts[i]
        x2, y2, _ = verts[(i + 1) % n]
        if abs(b) < 1e-9:
            continue
        sweep = 4 * math.atan(abs(b))
        c = math.hypot(x2 - x, y2 - y)
        r = c / 2 / math.sin(sweep / 2)
        mx, my = (x + x2) / 2, (y + y2) / 2
        h = math.sqrt(max(r * r - (c / 2) ** 2, 0))
        ux, uy = (x2 - x) / c, (y2 - y) / c
        sgn = 1 if b > 0 else -1
        # centre lies to the left of the chord for b>0 when sweep<180, mirrored otherwise
        k = 1 if sweep <= math.pi else -1
        cx, cy = mx - sgn * k * h * uy, my + sgn * k * h * ux
        # arc midpoint direction: from centre through the bulge apex
        apex = (mx + sgn * uy * (c / 2) * abs(b), my - sgn * ux * (c / 2) * abs(b))
        am = math.degrees(math.atan2(apex[1] - cy, apex[0] - cx))
        out.append(((cx, cy), r, am, b))
    return out


def part_cell(part, datum=None, key_pts=(), table=False, pairs=(), extra=None,
              arcs=True, note=None, hole_notes=None, chain_pts=None, ring=False, ychain=True):
    """Flat part with chain dims (x below, y left), overall dims, hole Ø, arc R,
    optional coordinate table (relative to `datum`), and a label on top.

    key_pts: [(label, (x, y), description)] -- vertices / tangent points to locate.
    pairs:   [(p1, p2, offset_paper_mm)] aligned hole-to-hole reference dims.
    extra:   extra(pen, bb) for part-specific annotations.
    """
    def draw(pen):
        S = pen.S
        pen.bulge_poly(part.outer, "OUTLINE")
        for (cx, cy, d) in part.holes:
            pen.circle((cx, cy), d / 2)
            pen.center_cross((cx, cy), d / 2)
        for (a, b) in part.mark_lines:
            pen.line(a, b, "MARK")
        xmin, ymin, xmax, ymax = part.bbox

        feats = list(chain_pts or []) + [(cx, cy) for (cx, cy, _) in part.holes]
        xs = [xmin, xmax] + [f[0] for f in feats]
        ys = [ymin, ymax] + [f[1] for f in (feats if ychain else [(cx, cy) for (cx, cy, _) in part.holes])]

        def y_of(x):  # extension origin: nearest feature with that x, else bottom edge
            c = [f for f in feats if abs(f[0] - x) < 0.5]
            return c[0][1] if c else ymin

        def x_of(y):
            c = [f for f in feats if abs(f[1] - y) < 0.5]
            return c[0][0] if c else xmin

        if ring:
            (cx, cy, d) = part.holes[0]
            od = xmax - xmin
            pen.dia((cx, cy), od / 2, 30)
            pen.hdim((cx - d / 2, cy), (cx + d / 2, cy), ymin - 9 * S,
                     text=f"Ø{fmt(d)}" + (hole_notes or {}).get(d, ""))
            pen.text(_label(part), (xmin, ymax + 12 * S), 3.5, "L")
            return
        tier = 7 * S
        yb = ymin - 9 * S
        pen.hchain(xs, y_of, yb)
        if len(_dedup(sorted(xs))) > 2:
            pen.hdim((xmin, y_of(xmin)), (xmax, y_of(xmax)), yb - tier)
        xl = xmin - 9 * S
        pen.vchain(ys, x_of, xl)
        if len(_dedup(sorted(ys))) > 2:
            pen.vdim((x_of(ymin), ymin), (x_of(ymax), ymax), xl - tier)

        # hole diameters: one callout per distinct size, written on the plate
        # next to the hole when it fits, otherwise with a leader
        seen = {}
        for (cx, cy, d) in part.holes:
            seen.setdefault(round(d, 2), []).append((cx, cy))
        poly = part.polygon
        for d, cs in seen.items():
            n = len(cs)
            txt = (f"{n}×Ø{fmt(d)}" if n > 1 else f"Ø{fmt(d)}") + (hole_notes or {}).get(d, "")
            if not _callout_inside(pen, poly, cs[0], d / 2, txt):
                cx, cy = cs[0]
                pen.leader((cx + d / 2 * 0.7071, cy + d / 2 * 0.7071),
                           (cx + d / 2 + 8 * S, cy + d / 2 + 8 * S), txt)

        if arcs:
            done = set()
            for (c, r, am, b) in _circles_of_outline(part.outer):
                key = (round(c[0], 1), round(c[1], 1), round(r, 1))
                if key in done or r > 5000:
                    continue
                done.add(key)
                if math.cos(math.radians(am)) < -0.7:      # keep R off the left-hand dims
                    am = 125.0
                pen.rad(c, r, am)

        for (a, b, off) in pairs:
            pen.adim(a, b, off)

        cen = part.polygon.centroid
        for (lab, (x, y), _) in key_pts:
            pen.circle((x, y), 0.8 * S, "THIN")
            dx, dy = x - cen.x, y - cen.y
            L = math.hypot(dx, dy) or 1.0
            pen.text(lab, (x + dx / L * 4 * S, y + dy / L * 4 * S), 2.2, "MC", "DIM")

        if extra:
            extra(pen, part.bbox)

        top = ymax + (14 if part.holes else 5) * S
        if note:
            for i, line in enumerate(reversed(note if isinstance(note, list) else [note])):
                pen.text(line, (xmin, top + i * 4.2 * S), 2.5, "L")
            top += len(note if isinstance(note, list) else [note]) * 4.2 * S
        pen.text(_label(part), (xmin, top + 1 * S), 3.5, "L")

        if table:
            ox, oy = datum if datum else (xmin, ymin)
            rows = [("点", "X", "Y", "说明")]
            for (lab, (x, y), desc) in key_pts:
                rows.append((lab, fmt(x - ox), fmt(y - oy), desc))
            _table(pen, rows, (xmax + 48 * S, ymax), [9, 17, 17, 44],
                   title=f"坐标表（原点 {datum_name(part, datum)}，单位mm）")
    return Cell(draw, part.pid)


def _text_w(s, h):
    return sum(1.0 if ord(ch) > 255 else 0.62 for ch in s) * h


def _callout_inside(pen, poly, c, r, txt, h=2.5):
    from shapely.geometry import box
    S = pen.S
    w, hh = _text_w(txt, h) * S, h * S
    g = 2.5 * S
    cx, cy = c
    cands = [(cx + r + g, cy - hh / 2, "ML", (cx + r + g, cy)),
             (cx - r - g - w, cy - hh / 2, "MR", (cx - r - g, cy)),
             (cx - w / 2, cy - r - g - hh, "C", (cx, cy - r - g - hh)),
             (cx - w / 2, cy + r + g, "C", (cx, cy + r + g))]
    for (x0, y0, al, pos) in cands:
        if poly.buffer(-1.0 * S).contains(box(x0, y0, x0 + w, y0 + hh)):
            pen.text(txt, pos, h, al, "DIM")
            return True
    return False


def datum_name(part, datum):
    if datum is None or (abs(datum[0] - part.bbox[0]) < 0.01 and abs(datum[1] - part.bbox[1]) < 0.01):
        return "外形左下角"
    for (cx, cy, d) in part.holes:
        if abs(cx - datum[0]) < 0.01 and abs(cy - datum[1]) < 0.01:
            return f"Ø{fmt(d)}孔中心"
    return "见图"


def _table(pen, rows, top_left, widths, title=None, rh=5.5, th=2.5):
    S = pen.S
    x0, y0 = top_left
    if title:
        pen.text(title, (x0, y0 + 1.5 * S), th, "L")
    W = sum(widths) * S
    for i, row in enumerate(rows):
        y = y0 - i * rh * S
        pen.line((x0, y), (x0 + W, y), "THIN")
        x = x0
        for w, cell in zip(widths, row):
            pen.text(str(cell), (x + 1.2 * S, y - rh * S / 2), th, "ML")
            x += w * S
    yb = y0 - len(rows) * rh * S
    pen.line((x0, yb), (x0 + W, yb), "THIN")
    x = x0
    for w in widths + [0]:
        pen.line((x, y0), (x, yb), "THIN")
        x += w * S


# ===========================================================================
# frame, title block, BOM, technical requirements
# ===========================================================================

TECH = [
    "技术要求：",
    "1. 材料 Q355B（刃板推荐 NM400）；激光切割，切割面去毛刺、锐边倒钝 C1。",
    "2. 组焊前先点焊定位，检查销孔同轴、两侧板平行后再满焊；焊脚高 ≥ 0.7×较薄板厚，连续焊，无咬边气孔。",
    "3. 所有销孔（标注“焊后镗”者）预留余量，整体焊接、消应力后一次线镗至图示精度，保证两侧同轴。",
    "4. 未注线性尺寸公差按 GB/T 1804-m；未注形位公差按 GB/T 1184-K。",
    "5. 本图为按公开参数推算的自主设计，非原厂图纸；承力件上机前须由结构工程师复核强度与焊缝。",
]


def title_block(pen, x1, y0, info):
    """Title block with its bottom-right corner at (x1, y0) (inner frame corner)."""
    S = pen.S
    w = [25, 55, 25, 75]
    rh = 8
    rows = [("图名", info["name"], "图号", info["no"]),
            ("材料", "Q355B（刃板 NM400）", "比例", f"1:{fmt(info['S'])}"),
            ("焊接件重", f"{info['mass']:.1f} kg（不含外购件）", "图幅", info["paper"]),
            ("设计", "Claude 自主设计", "日期", DATE),
            ("投影", "第一角画法", "张次", f"第 {info['sheet']} 张 共 {info['total']} 张")]
    W = sum(w) * S
    H = len(rows) * rh * S
    x0 = x1 - W
    top = y0 + H
    for i, row in enumerate(rows):
        y = top - i * rh * S
        pen.line((x0, y), (x1, y), "THIN")
        x = x0
        for k, (ww, c) in enumerate(zip(w, row)):
            pen.text(c, (x + 1.5 * S, y - rh * S / 2), 3.5 if k % 2 else 3.0, "ML")
            x += ww * S
    x = x0
    for ww in w + [0]:
        pen.line((x, top), (x, y0), "THIN")
        x += ww * S
    pen.poly([(x0, y0), (x1, y0), (x1, top), (x0, top)], "FRAME", close=True)
    return x0, top


def bom_table(pen, x1, y0, items):
    """明细栏 above... placed with bottom-right at (x1, y0); items rows."""
    S = pen.S
    w = [9, 12, 36, 9, 26, 20, 15, 15, 36]
    head = ("序号", "代号", "名称", "数量", "材料", "厚度", "单重kg", "总重kg", "备注")
    rows = [head] + items
    rh = 6.5
    W = sum(w) * S
    x0 = x1 - W
    H = len(rows) * rh * S
    top = y0 + H
    # GB: header row at the bottom, items numbered upward
    ordered = list(reversed(rows))
    for i, row in enumerate(ordered):
        y = top - i * rh * S
        pen.line((x0, y), (x1, y), "THIN")
        x = x0
        for ww, c in zip(w, row):
            pen.text(str(c), (x + 1 * S, y - rh * S / 2), 2.5, "ML")
            x += ww * S
    pen.line((x0, y0), (x1, y0), "THIN")
    x = x0
    for ww in w + [0]:
        pen.line((x, top), (x, y0), "THIN")
        x += ww * S
    pen.text("明细栏", (x0, top + 1.5 * S), 3.5, "L")
    return x0, top


def tech_block(pen, x0, y_top, lines):
    for i, s in enumerate(lines):
        pen.text(s, (x0, y_top - (i + 1) * 5.2 * pen.S), 3.2 if i == 0 else 2.8, "L")
    return len(lines) * 5.2 * pen.S


# ===========================================================================
# sheet assembly + layout search
# ===========================================================================

def _pack(cells, regions, gap):
    """Shelf-pack cells, in order, into a sequence of regions (x0, yb, x1, yt):
    fill the first region row by row, then continue in the next one.
    Returns [(cell, dx, dy)] or None if they do not all fit."""
    out = []
    ri = 0
    x0, yb, x1, yt = regions[0]
    cx, top, row_h = x0, yt, 0.0
    for c in cells:
        while True:
            if cx + c.w > x1 and cx > x0:          # new shelf
                cx, top, row_h = x0, top - row_h - gap, 0.0
            if c.w <= x1 - x0 and top - c.h >= yb:
                break
            ri += 1                                 # next region
            if ri >= len(regions):
                return None
            x0, yb, x1, yt = regions[ri]
            cx, top, row_h = x0, yt, 0.0
        out.append((c, cx - c.bb[0], top - c.bb[3]))
        cx += c.w + gap
        row_h = max(row_h, c.h)
    return out


def build_sheet(path_stub, info, views, part_cells, bom_items, extra_tech=()):
    """views: dict front/top/left -> Cell (geometry-aligned: shared local frames).
    Tries A1 then A0 at increasing scale until everything fits."""
    tried = []
    cands = [("A1", S) for S in SCALES if S <= 6] + [("A0", S) for S in SCALES if S >= 3] + [("A1", 10.0)]
    for paper, S in cands:
        res = _try_layout(paper, S, views, part_cells, bom_items, extra_tech)
        tried.append((paper, S, res is not None))
        if res is not None:
            return _render(path_stub, info, paper, S, res, views, part_cells, bom_items, extra_tech)
    raise RuntimeError(f"sheet {path_stub}: nothing fits {tried}")


def _band_height(S, n_bom):
    return max(5 * 8 + 3, (n_bom + 1) * 6.5 + 6, len(TECH) * 5.2 + 26) * S


def _try_layout(paper, S, views, part_cells, bom_items, extra_tech):
    Wp, Hp = PAPERS[paper]
    for c in list(views.values()) + part_cells:
        c.measure(S)
    gap = 14 * S
    x_in0, y_in0, x_in1, y_in1 = 25 * S, 10 * S, (Wp - 10) * S, (Hp - 10) * S
    cx0, cx1 = x_in0 + 8 * S, x_in1 - 8 * S
    cy1 = y_in1 - 8 * S
    band = _band_height(S, len(bom_items)) + y_in0 + 8 * S

    F, T, L = views["front"], views["top"], views["left"]
    fo = (cx0 - F.bb[0], cy1 - F.bb[3])
    lo = (fo[0] + F.bb[2] + gap - L.bb[0], fo[1])
    to = (fo[0], fo[1] + F.bb[1] - gap - T.bb[3])
    right = max(fo[0] + F.bb[2], lo[0] + L.bb[2], to[0] + T.bb[2])
    bottom = min(to[1] + T.bb[1], lo[1] + L.bb[1])
    if right > cx1 or bottom < band:
        return None
    # parts: right of the views first, then the full width below the views
    regions = [(right + gap * 1.5, max(band, bottom), cx1, cy1), (cx0, band, cx1, bottom - gap)]
    placed = _pack(part_cells, regions, gap)
    if placed is None:
        return None
    return dict(fo=fo, lo=lo, to=to, placed=placed, frame=(x_in0, y_in0, x_in1, y_in1), W=Wp * S, H=Hp * S)


def _render(path_stub, info, paper, S, res, views, part_cells, bom_items, extra_tech):
    doc = new_doc(S)
    msp = doc.modelspace()
    pen = Pen(msp, S)
    W, H = res["W"], res["H"]
    pen.poly([(0, 0), (W, 0), (W, H), (0, H)], "THIN", close=True)
    x0, y0, x1, y1 = res["frame"]
    pen.poly([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], "FRAME", close=True)

    views["front"].draw(Pen(msp, S, *res["fo"]))
    views["left"].draw(Pen(msp, S, *res["lo"]))
    views["top"].draw(Pen(msp, S, *res["to"]))
    for c, dx, dy in res["placed"]:
        c.draw(Pen(msp, S, dx, dy))

    info = dict(info, S=S, paper=paper)
    tx0, ttop = title_block(pen, x1, y0, info)
    bx0, btop = bom_table(pen, tx0 - 6 * S, y0, bom_items)
    lines = TECH + [f"{i + 6}. {s}" for i, s in enumerate(extra_tech)]
    tech_block(pen, x0 + 8 * S, y0 + _band_height(S, len(bom_items)), lines)

    auditor = doc.audit()
    assert not auditor.has_errors, f"{path_stub}: DXF audit errors {auditor.errors}"
    doc.saveas(path_stub + ".dxf")
    _export(doc, path_stub, paper)
    return dict(scale=S, paper=paper)


def _export(doc, path_stub, paper):
    Wp, Hp = PAPERS[paper]
    cfg = config.Configuration(background_policy=config.BackgroundPolicy.WHITE,
                               color_policy=config.ColorPolicy.BLACK,
                               lineweight_policy=config.LineweightPolicy.ABSOLUTE,
                               lineweight_scaling=1.0, min_lineweight=0.12)
    be = pymupdf.PyMuPdfBackend()
    Frontend(RenderContext(doc), be, config=cfg).draw_layout(doc.modelspace())
    page = layout.Page(Wp, Hp, layout.Units.mm, margins=layout.Margins.all(0))
    st = layout.Settings(fit_page=True)
    with open(path_stub + ".pdf", "wb") as f:
        f.write(be.get_pdf_bytes(page, settings=st))
    with open(path_stub + ".png", "wb") as f:
        f.write(be.get_pixmap_bytes(page, fmt="png", dpi=110, settings=st))
