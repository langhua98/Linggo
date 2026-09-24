#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
parts.py -- laser part definitions (2D outline + holes + marks) for every
weldment: arm (斗杆) A1-A6, bucket linkage L1-L2, bucket (铲斗) K1-K6,
boom (动臂) B1-B6. Builds ezdxf-ready geometry + shapely polygons for mass/
interference checks. Each Part also carries a `placement` (ang_rad, dx, dy)
describing how its own local 2D frame maps into its parent assembly frame,
used later by model3d.py to place 3D solids.
"""

import math
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

import geom as G
from geom import (
    vsub, vadd, vscale, vlen, vunit, rot, vmid,
    tangent_chain, circle_as_polyline, flatten_bulge_ring,
    polygon_with_holes, rect_verts, transform_verts,
)

IDENTITY_PLACEMENT = (0.0, 0.0, 0.0)  # (ang_rad, dx, dy)


class Part:
    def __init__(self, pid, name_cn, name_en, thickness, qty, outer, holes=None,
                 mark_lines=None, mark_notes=None, material=G.MATERIAL, bom_note="",
                 group="", placement=IDENTITY_PLACEMENT):
        self.pid = pid
        self.name_cn = name_cn
        self.name_en = name_en
        self.thickness = thickness
        self.qty = qty
        self.outer = outer          # list of (x,y,bulge), closed ring, LOCAL frame
        self.holes = holes or []    # list of (cx,cy,d), LOCAL frame
        self.mark_lines = mark_lines or []
        self.mark_notes = mark_notes or []
        self.material = material
        self.bom_note = bom_note
        self.group = group          # "bucket" / "arm" / "boom"
        self.placement = placement  # (ang_rad, dx, dy): local -> parent-assembly frame
        self._poly = None

    @property
    def polygon(self):
        if self._poly is None:
            self._poly = polygon_with_holes(self.outer, self.holes)
        return self._poly

    @property
    def bbox(self):
        return self.polygon.bounds

    def area_mm2(self):
        return self.polygon.area

    def mass_kg_each(self):
        return self.area_mm2() * self.thickness * G.STEEL_DENSITY / 1000.0

    def filename(self):
        return f"{self.pid}_{self.name_en}_t{self.thickness}_x{self.qty}.dxf"


def _seg_len(seg):
    return vlen(vsub(seg[1], seg[0]))


def y_on_line_at_x(p1, p2, x):
    x1, y1 = p1
    x2, y2 = p2
    if abs(x2 - x1) < 1e-9:
        return y1
    return y1 + (y2 - y1) * (x - x1) / (x2 - x1)


def point_at_x_on_segments(segments, x, tol=1e-6):
    """segments: list of (p1,p2) straight tangent segments (geometric order).
    Returns the (x,y) point on whichever segment's x-range contains x."""
    for (p1, p2) in segments:
        xlo, xhi = sorted([p1[0], p2[0]])
        if xlo - tol <= x <= xhi + tol:
            return (x, y_on_line_at_x(p1, p2, x))
    raise ValueError(f"x={x} not covered by any of the given segments")


# ===========================================================================
# GROUP 1 -- ARM (斗杆)  -- spec v2 revision
# ===========================================================================

def build_arm_parts():
    parts = []
    A, D, B, C, E = G.ARM_A, G.ARM_D, G.ARM_B, G.ARM_C, G.ARM_E

    # ---- A1 side plate: A R50+1 -> D R45+1 -> B R45+1 -> back to A --------
    circles_a1 = [
        (A[0], A[1], 50, 1),
        (D[0], D[1], 45, 1),
        (B[0], B[1], 45, 1),
    ]
    verts_a1, segs_a1 = tangent_chain(circles_a1)
    seg_AD = segs_a1[0]   # A -> D
    seg_DB = segs_a1[1]   # D -> B  (top edge, tangent-chain order)
    seg_BA = segs_a1[2]   # B -> A  (rear edge)

    poly_a1 = polygon_with_holes(verts_a1, [])
    assert poly_a1.is_valid and poly_a1.exterior.is_ccw, "A1 outline invalid/not CCW"
    e_circle = Point(E).buffer(36, resolution=128)
    assert poly_a1.contains(e_circle), "A1: circle E R36 must lie fully inside outline"
    assert not poly_a1.contains(Point(C)), "A1: C must lie OUTSIDE (above) outline"
    G.log(f"[assert OK] A1: circle E{E} R36 inside outline, C{C} outside outline")

    a1 = Part(
        "A1", "臂侧板", "arm_side_plate", 10, 2, verts_a1,
        holes=[(A[0], A[1], 60.5), (D[0], D[1], 50.5), (E[0], E[1], 50.5), (B[0], B[1], 28)],
        bom_note="A/D/E/B孔均先焊后精加工：A→Ø60.5(装衬套)，D/E→Ø50.5(装衬套)，B→焊后线镗至Ø30H9",
        group="arm",
    )
    parts.append(a1)

    # ---- A2 bottom plate t12 w75, along A->D --------------------------------
    len_AD = _seg_len(seg_AD)
    ang_AD = math.atan2(seg_AD[1][1] - seg_AD[0][1], seg_AD[1][0] - seg_AD[0][0])
    a2 = Part("A2", "臂底板", "arm_bottom_plate", 12, 1, rect_verts(len_AD, 75),
              bom_note="长度按实物修配 ±2 (对应 A->D 切线段)", group="arm",
              placement=(ang_AD, seg_AD[0][0], seg_AD[0][1]))
    parts.append(a2)

    # ---- A3 top plate t10 w75: D-tangent-pt back to x=-120 on the D-B line -
    len_DB = _seg_len(seg_DB)
    ang_DB = math.atan2(seg_DB[1][1] - seg_DB[0][1], seg_DB[1][0] - seg_DB[0][0])
    x_cut = -120.0
    # point on the D->B line at arm-frame x = -120 (window boundary)
    p_cut = point_at_x_on_segments([seg_DB], x_cut) if (min(seg_DB[0][0], seg_DB[1][0]) - 1e-6 <= x_cut
                                                          <= max(seg_DB[0][0], seg_DB[1][0]) + 1e-6) else None
    assert p_cut is not None, "A3: x=-120 window boundary not on D->B tangent segment"
    len_A3 = vlen(vsub(p_cut, seg_DB[0]))  # from D tangent point to the x=-120 point
    a3 = Part("A3", "臂顶板", "arm_top_plate", 10, 1, rect_verts(len_A3, 75),
              bom_note=(f"自D切线点沿D->B切线方向至x=-120(臂系)处，长度按实物修配 ±2；"
                        f"x<-120至B切线点段为敞开窗口，供臂缸杆头进出"),
              group="arm", placement=(ang_DB, seg_DB[0][0], seg_DB[0][1]))
    parts.append(a3)

    # ---- A4 rear plate t10 w75, full B->A -----------------------------------
    len_BA = _seg_len(seg_BA)
    ang_BA = math.atan2(seg_BA[1][1] - seg_BA[0][1], seg_BA[1][0] - seg_BA[0][0])
    a4 = Part("A4", "臂后板", "arm_rear_plate", 10, 1, rect_verts(len_BA, 75),
              bom_note="长度=B->A切线段(全长)", group="arm",
              placement=(ang_BA, seg_BA[0][0], seg_BA[0][1]))
    parts.append(a4)

    # ---- A5 bucket-cylinder lug: hull(circle C R40, pts on D-B top edge at x=90,220) minus arm --
    p90 = point_at_x_on_segments([seg_DB], 90.0)
    p220 = point_at_x_on_segments([seg_DB], 220.0)
    hull5 = unary_union([Point(C).buffer(40, resolution=256),
                          Point(p90).buffer(0.01), Point(p220).buffer(0.01)]).convex_hull
    lug_poly = hull5.difference(poly_a1)
    if lug_poly.geom_type == "MultiPolygon":
        lug_poly = max(lug_poly.geoms, key=lambda g: g.area)
    ring = list(lug_poly.exterior.coords)[:-1]
    verts_a5 = [(x, y, 0.0) for (x, y) in ring]
    a5 = Part("A5", "斗缸耳板", "cyl_lug", 12, 2, verts_a5,
              holes=[(C[0], C[1], 28)],
              bom_note="焊后线镗至Ø30H9；轮廓弧线部分按≤0.05mm弦高折线逼近；两耳内间距62",
              group="arm")
    parts.append(a5)

    # ---- A6 rings at B -------------------------------------------------------
    a6 = Part("A6", "B处加强环", "reinforcing_ring", 10, 2,
              circle_as_polyline(B[0], B[1], 35.0),
              holes=[(B[0], B[1], 28)],
              bom_note="贴焊于两侧侧板外侧，随侧板一起镗孔", group="arm")
    parts.append(a6)

    kin_info = dict(seg_AD=seg_AD, seg_DB=seg_DB, seg_BA=seg_BA, poly_a1=poly_a1,
                     p90=p90, p220=p220, p_cut=p_cut, len_A3=len_A3)
    return parts, kin_info


# ===========================================================================
# GROUP 2 -- BUCKET LINKAGE (unchanged geometry)
# ===========================================================================

def build_linkage_parts():
    parts = []
    verts_l1, _ = tangent_chain([(0.0, 0.0, 35, 1), (230.0, 0.0, 35, 1)])
    l1 = Part("L1", "斗杆连杆", "arm_link", 10, 2, verts_l1,
              holes=[(0.0, 0.0, 28), (230.0, 0.0, 28)],
              bom_note="孔铰制至Ø30H9；套装于臂杆外侧，内间距97", group="linkage")
    parts.append(l1)

    verts_l2, _ = tangent_chain([(0.0, 0.0, 35, 1), (210.0, 0.0, 35, 1)])
    l2 = Part("L2", "铲斗连杆", "bucket_link", 10, 2, verts_l2,
              holes=[(0.0, 0.0, 28), (210.0, 0.0, 28)],
              bom_note="孔铰制至Ø30H9；装于斗耳板之间，外侧总宽95", group="linkage")
    parts.append(l2)
    return parts


# ===========================================================================
# GROUP 3 -- BUCKET (铲斗)  -- unchanged geometry, bucket frame: D at origin
# ===========================================================================

def build_bucket_parts():
    parts = []
    D0, G0, T0 = G.BKT_D, G.BKT_G, G.BKT_T
    P1_0, P2_0, B1_0, ARC_C, ARC_R, B2_0 = (G.BKT_P1, G.BKT_P2, G.BKT_B1,
                                             G.BKT_ARC_C, G.BKT_ARC_R, G.BKT_B2)

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
    G.log(f"Bucket struck area = {struck_area:.1f} mm^2, width 384mm -> struck volume = {struck_vol_m3:.5f} m^3")

    k1 = Part("K1", "斗侧板", "bucket_side_plate", 8, 2, verts_k1,
              bom_note=f"外部型线（斗型外轮廓）；铲斗结构容量≈{struck_vol_m3:.4f} m^3", group="bucket")
    parts.append(k1)

    k2 = Part("K2", "斗顶板", "bucket_top_plate", 8, 1, rect_verts(384, 280),
              bom_note="对应 P1->P2 顶部", group="bucket",
              placement=(math.pi, P2_0[0], P1_0[1]))
    parts.append(k2)

    k3 = Part("K3", "刃板", "cutting_edge", 12, 1, rect_verts(384, 110),
              material="NM400(或Q355替代)",
              mark_notes=[(192, 55, "前缘开 30° 坡口(刃口)，可焊接式斗齿另购")],
              bom_note="下缘落于 T->B1 线,自T起; NM400推荐, Q355B可替代", group="bucket")
    parts.append(k3)

    # ---- K4 wrap plate: developed length on neutral line -----------------
    d_T_B1 = vlen(vsub(T0, B1_0))
    straight1 = d_T_B1 - 110.0
    arc_len_neutral = math.pi * 177.0 / 2.0  # 90 deg at R177
    straight2 = vlen(vsub(B2_0, P1_0))
    Ldev = straight1 + arc_len_neutral + straight2
    G.log(f"K4 wrap plate developed length: straight1={straight1:.2f} + arc(R177,90deg)={arc_len_neutral:.2f} "
          f"+ straight2={straight2:.2f} = Ldev={Ldev:.2f} mm")

    bend1_x = straight1
    bend2_x = straight1 + arc_len_neutral
    k4 = Part("K4", "底弧板", "wrap_plate", 6, 1,
              rect_verts(Ldev, 384),
              mark_lines=[((bend1_x, 0.0), (bend1_x, 384.0)), ((bend2_x, 0.0), (bend2_x, 384.0))],
              mark_notes=[(Ldev / 2.0, 392.0, "卷弧 R177(中性层)/内 R174")],
              bom_note=f"平板展开 384 x {Ldev:.1f}；两条MARK线之间卷弧，线外两端保持平直", group="bucket")
    parts.append(k4)

    # ---- K5 ear plate ------------------------------------------------------
    seg_a = (60.0, -95.0)
    seg_b = (-180.0, -95.0)
    circles5 = [(seg_a[0], seg_a[1], 0, 1), (D0[0], D0[1], 45, 1), (G0[0], G0[1], 45, 1), (seg_b[0], seg_b[1], 0, 1)]
    verts_k5, _ = tangent_chain(circles5)
    poly_k5 = polygon_with_holes(verts_k5, [])
    assert poly_k5.is_valid and poly_k5.exterior.is_ccw, "K5 outline invalid/not CCW"
    k5 = Part("K5", "斗耳板", "ear_plate", 12, 2, verts_k5,
              holes=[(D0[0], D0[1], 50.5), (G0[0], G0[1], 50.5)],
              bom_note="耳板站立于斗顶板上；两耳内间距97，臂宽95插入其间", group="bucket")
    parts.append(k5)

    # ---- K6 ear gusset -------------------------------------------------------
    verts_k6 = [(10.0, 0.0, 0.0), (60.0, 0.0, 0.0), (0.0, 60.0, 0.0), (0.0, 10.0, 0.0)]
    k6 = Part("K6", "耳板三角筋板", "ear_gusset", 8, 4, verts_k6,
              bom_note="直角处10x10清角，避免与斗顶板/耳板焊角干涉", group="bucket")
    parts.append(k6)

    return parts, dict(struck_vol_m3=struck_vol_m3, poly_k1=poly_k1)


# ===========================================================================
# GROUP 4 -- BOOM (动臂/大臂)  -- NEW
# ===========================================================================

def build_boom_parts():
    parts = []
    O, K, Aj = G.BOOM_O, G.BOOM_K, G.BOOM_A
    M, N = G.BOOM_M, G.BOOM_N
    Ct, Cb = G.BOOM_CT, G.BOOM_CB

    circles_b1 = [
        (O[0], O[1], 80, 1),
        (Cb[0], Cb[1], 24, -1),
        (Aj[0], Aj[1], 60, 1),
        (Ct[0], Ct[1], 36, 1),
    ]
    verts_b1, segs_b1 = tangent_chain(circles_b1)
    seg_O_Cb = segs_b1[0]   # O -> Cb  (belly, near-foot straight)
    seg_Cb_A = segs_b1[1]   # Cb -> A  (belly, near-tip straight)
    seg_A_Ct = segs_b1[2]   # A -> Ct  (end cap arc region straight)
    seg_Ct_O = segs_b1[3]   # Ct -> O  (top, single straight)

    poly_b1 = polygon_with_holes(verts_b1, [])
    assert poly_b1.is_valid and poly_b1.exterior.is_ccw, "B1 outline invalid/not CCW"
    assert not poly_b1.contains(Point(M)), "B1: M must lie OUTSIDE outline (below belly)"
    assert not poly_b1.contains(Point(N)), "B1: N must lie OUTSIDE outline (above top)"
    G.log(f"[assert OK] B1: M{M} outside (below belly), N{N} outside (above top); "
          f"knee bisector u = {G.BOOM_KNEE_U_DEG:.2f} deg, K={K}")

    b1 = Part("B1", "动臂侧板", "boom_side_plate", 10, 2, verts_b1,
              holes=[(O[0], O[1], 70.5), (Aj[0], Aj[1], 33)],
              bom_note="O孔Ø70.5装脚部衬套；A孔焊后与B6环一起线镗至Ø35H9", group="boom")
    parts.append(b1)

    # ---- B2 top plate: developed blank, bend at Ct knee --------------------
    len_top1 = _seg_len(seg_A_Ct)   # A tangent point -> Ct tangent point (near A)
    len_top2 = _seg_len(seg_Ct_O)   # Ct tangent point -> O tangent point (near O)
    neutral_r = G.BOOM_BEND_INNER_R + G.BOOM_K_FACTOR * 12.0
    arc_top = math.radians(G.BOOM_BEND_ANGLE_DEG) * neutral_r
    Ldev_top = len_top1 + arc_top + len_top2
    bend_top_x1 = len_top1
    bend_top_x2 = len_top1 + arc_top
    G.log(f"B2 top plate developed length: {len_top1:.2f}(A->Ct) + {arc_top:.2f}(bend,R{neutral_r:.2f} @"
          f"{G.BOOM_BEND_ANGLE_DEG}deg) + {len_top2:.2f}(Ct->O) = {Ldev_top:.2f} mm")
    b2 = Part("B2", "动臂顶板", "boom_top_plate", 12, 1, rect_verts(Ldev_top, 97),
              mark_lines=[((bend_top_x1, 0.0), (bend_top_x1, 97.0)),
                          ((bend_top_x2, 0.0), (bend_top_x2, 97.0))],
              mark_notes=[(Ldev_top / 2.0, 105.0,
                            f"折弯 {G.BOOM_BEND_ANGLE_DEG:.0f}°, 内R{G.BOOM_BEND_INNER_R:.0f}, K=0.4")],
              bom_note=f"整板一次折弯成型于膝部；展开长度 {Ldev_top:.1f}；一件覆盖动臂全长顶面",
              group="boom")
    parts.append(b2)

    # ---- B3 bottom (belly) plate: developed blank, bend at Cb knee ---------
    len_bot1 = _seg_len(seg_O_Cb)    # O tangent point -> Cb tangent point (near O)
    len_bot2 = _seg_len(seg_Cb_A)    # Cb tangent point -> A tangent point (near A)
    arc_bot = arc_top  # same t=12, same inner R24, same K-factor, same bend angle
    Ldev_bot = len_bot1 + arc_bot + len_bot2
    bend_bot_x1 = len_bot1
    bend_bot_x2 = len_bot1 + arc_bot
    G.log(f"B3 bottom plate developed length: {len_bot1:.2f}(O->Cb) + {arc_bot:.2f}(bend,R{neutral_r:.2f} @"
          f"{G.BOOM_BEND_ANGLE_DEG}deg) + {len_bot2:.2f}(Cb->A) = {Ldev_bot:.2f} mm")
    b3 = Part("B3", "动臂底板(腹板)", "boom_bottom_plate", 12, 1, rect_verts(Ldev_bot, 97),
              mark_lines=[((bend_bot_x1, 0.0), (bend_bot_x1, 97.0)),
                          ((bend_bot_x2, 0.0), (bend_bot_x2, 97.0))],
              mark_notes=[(Ldev_bot / 2.0, 105.0,
                            f"折弯 {G.BOOM_BEND_ANGLE_DEG:.0f}°, 内R{G.BOOM_BEND_INNER_R:.0f}, K=0.4"
                            "（凹面为板材内侧/弯曲内圆角面）")],
              bom_note=f"整板一次折弯成型于膝部；展开长度 {Ldev_bot:.1f}；一件覆盖动臂全长底面(腹板)",
              group="boom")
    parts.append(b3)

    # ---- B4 boom-cylinder lug: hull(circle M R45, pts on belly at M.x+-80) --
    belly_segments = [seg_O_Cb, seg_Cb_A]
    pM1 = point_at_x_on_segments(belly_segments, M[0] - 80.0)
    pM2 = point_at_x_on_segments(belly_segments, M[0] + 80.0)
    hullM = unary_union([Point(M).buffer(45, resolution=256),
                          Point(pM1).buffer(0.01), Point(pM2).buffer(0.01)]).convex_hull
    lugM_poly = hullM.difference(poly_b1)
    if lugM_poly.geom_type == "MultiPolygon":
        lugM_poly = max(lugM_poly.geoms, key=lambda g: g.area)
    ringM = list(lugM_poly.exterior.coords)[:-1]
    verts_b4 = [(x, y, 0.0) for (x, y) in ringM]
    b4 = Part("B4", "动臂缸耳板", "boom_cyl_lug", 16, 2, verts_b4,
              holes=[(M[0], M[1], 33)],
              bom_note="焊后与孔一起线镗至Ø35H9；两耳内间距72(外104<117)；轮廓弧线按≤0.05mm弦高折线逼近",
              group="boom")
    parts.append(b4)

    # ---- B5 arm-cylinder lug: hull(circle N R45, pts on top at N.x+-80) -----
    top_segments = [seg_Ct_O, seg_A_Ct]
    pN1 = point_at_x_on_segments(top_segments, N[0] - 80.0)
    pN2 = point_at_x_on_segments(top_segments, N[0] + 80.0)
    hullN = unary_union([Point(N).buffer(45, resolution=256),
                          Point(pN1).buffer(0.01), Point(pN2).buffer(0.01)]).convex_hull
    lugN_poly = hullN.difference(poly_b1)
    if lugN_poly.geom_type == "MultiPolygon":
        lugN_poly = max(lugN_poly.geoms, key=lambda g: g.area)
    ringN = list(lugN_poly.exterior.coords)[:-1]
    verts_b5 = [(x, y, 0.0) for (x, y) in ringN]
    b5 = Part("B5", "臂缸耳板", "arm_cyl_lug", 16, 2, verts_b5,
              holes=[(N[0], N[1], 33)],
              bom_note="焊后与孔一起线镗至Ø35H9；两耳内间距72；轮廓弧线按≤0.05mm弦高折线逼近",
              group="boom")
    parts.append(b5)

    # ---- B6 tip ring at A -----------------------------------------------------
    b6 = Part("B6", "臂销端环板", "tip_ring", 12, 2,
              circle_as_polyline(Aj[0], Aj[1], 45.0),
              holes=[(Aj[0], Aj[1], 33)],
              bom_note="贴焊于两侧侧板外侧A孔处，与B1一起镗孔至Ø35H9 (OD90 ID33)",
              group="boom")
    parts.append(b6)

    kin_info = dict(seg_O_Cb=seg_O_Cb, seg_Cb_A=seg_Cb_A, seg_A_Ct=seg_A_Ct, seg_Ct_O=seg_Ct_O,
                     poly_b1=poly_b1, pM1=pM1, pM2=pM2, pN1=pN1, pN2=pN2)
    return parts, kin_info
