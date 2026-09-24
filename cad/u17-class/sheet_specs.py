#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sheet_specs.py -- what goes on each drawing sheet: which dimensions each
assembly view carries, how each flat part is dimensioned (datum, coordinate
table, notes) and the 明细栏 rows.  Geometry comes from geom/parts; drawing
mechanics from sheets.py.
"""

import math
import os

import geom as G
import sheets as SH
from sheets import fmt, part_cell, view_cell, hlr

STEEL = 7.85e-6  # kg/mm^3


def _tube_mass(od, idd, L):
    return math.pi / 4 * (od ** 2 - idd ** 2) * L * STEEL


def _outline_pts(part, prefix="T"):
    """Line/arc junction points of a bulge outline, labelled T1..Tn."""
    pts = []
    for (x, y, _) in part.outer:
        if not any(math.dist((x, y), q) < 0.05 for (_, q, _) in pts):
            pts.append((f"{prefix}{len(pts) + 1}", (x, y), "切点/交点"))
    return pts


def _lug_pts(part, c, r, base):
    """Key points of a hull lug: hole centre, the two circle tangent points and
    the two ends of the base edge (the edge that follows the parent plate)."""
    ring = [(x, y) for (x, y, _) in part.outer]
    on_c = [i for i, q in enumerate(ring) if abs(math.dist(q, c) - r) < 0.05]
    n = len(ring)
    s = set(on_c)
    t1 = ring[[i for i in on_c if (i - 1) % n not in s][0]]
    t2 = ring[[i for i in on_c if (i + 1) % n not in s][0]]
    e1, e2 = sorted(base, key=lambda q: q[0])
    return [("C", c, f"孔心 / R{fmt(r)} 圆心"),
            ("T1", t1, "R弧切点"), ("T2", t2, "R弧切点"),
            ("E1", e1, "底边端点"), ("E2", e2, "底边端点")]


def _bom_rows(parts, purchased):
    rows = []
    for i, p in enumerate(parts, 1):
        m = p.mass_kg_each()
        rows.append((i, p.pid, p.name_cn, p.qty, p.material.replace("(或Q355替代)", ""),
                     f"t{p.thickness}", f"{m:.2f}", f"{m * p.qty:.2f}", "激光切割"))
    k = len(rows)
    for j, (code, name, qty, mat, spec, m, note) in enumerate(purchased, 1):
        rows.append((k + j, code, name, qty, mat, spec, f"{m:.2f}", f"{m * qty:.2f}", note))
    return rows


def _mass(parts, purchased):
    return sum(p.mass_kg_each() * p.qty for p in parts) + sum(q * m for (_, _, q, _, _, m, _) in purchased)


def _views(solid, dims):
    """dims: dict view -> (dims_fn, centers)."""
    out = {}
    names = {"front": "主视图", "top": "俯视图", "left": "左视图"}
    for v in ("front", "top", "left"):
        fn, centers = dims[v]
        out[v] = view_cell(hlr(solid, v), names[v], fn, centers)
    return out


def _chain_h(pen, pts, y):
    pts = sorted(pts, key=lambda q: q[0])
    out = [pts[0]]
    for q in pts[1:]:
        if abs(q[0] - out[-1][0]) > 0.5:
            out.append(q)
    for a, b in zip(out, out[1:]):
        pen.hdim(a, b, y)


def _chain_v(pen, pts, x):
    pts = sorted(pts, key=lambda q: q[1])
    out = [pts[0]]
    for q in pts[1:]:
        if abs(q[1] - out[-1][1]) > 0.5:
            out.append(q)
    for a, b in zip(out, out[1:]):
        pen.vdim(a, b, x)


def _pin_note(pen, c, r, s, dx=1, dy=1, knee=None):
    S = pen.S
    tip = (c[0] + dx * r * 0.7071, c[1] + dy * r * 0.7071)
    if knee is None:
        knee = (c[0] + dx * (r + 14 * S), c[1] + dy * (r + 12 * S))
    pen.leader(tip, knee, s)


def _zpair(pen, x, z, xtier, xfeat):
    """Vertical (in the top view) width dim of +-z at tier x, ext. lines from x=xfeat."""
    pen.vdim((xfeat, -z), (xfeat, z), xtier)


# ===========================================================================
# 01 BUCKET
# ===========================================================================

def bucket_sheet(path_stub, solid, parts, total_sheets):
    D, Gp, T = G.BKT_D, G.BKT_G, G.BKT_T
    P1, P2, B1, B2, AC, AR = G.BKT_P1, G.BKT_P2, G.BKT_B1, G.BKT_B2, G.BKT_ARC_C, G.BKT_ARC_R
    ear_top = (0.0, 45.0)

    def front(pen, bb):
        S = pen.S
        xmin, ymin, xmax, ymax = bb
        y1 = ymin - 10 * S
        _chain_h(pen, [P1, Gp, B1, D, P2, T], y1)
        pen.hdim((xmin, P1[1]), (xmax, T[1]), y1 - 7 * S)
        x1 = xmin - 10 * S
        _chain_v(pen, [B1, T, B2, P1, Gp, D, ear_top], x1)
        pen.vdim(B1, ear_top, x1 - 7 * S)
        pen.adim(D, Gp, -14)
        pen.adim(D, T, 22)
        pen.ang(D, Gp, T, 150)
        pen.rad(AC, AR, 225)
        _pin_note(pen, D, 25, "D 斗杆铰点 Ø30H8（焊后镗）", 1, 1)
        _pin_note(pen, Gp, 25, "G 连杆铰点 Ø30H8（焊后镗）", -1, 1, knee=(Gp[0] - 30, 45 + 14 * S))

    def top(pen, bb):
        S = pen.S
        xmin, ymin, xmax, ymax = bb
        xr = xmax + 10 * S
        _zpair(pen, xr, 192, xr, xmax)
        _zpair(pen, xr + 7 * S, 200, xr + 7 * S, xmax)
        xl = xmin - 10 * S
        _zpair(pen, xl, 48.5, xl, -180)
        _zpair(pen, xl - 7 * S, 60.5, xl - 7 * S, -180)
        _zpair(pen, xl - 14 * S, 73.5, xl - 14 * S, -131.56)
        pen.hdim((xmin, -200), (xmax, -200), ymin - 10 * S)

    def left(pen, bb):
        S = pen.S
        xmin, ymin, xmax, ymax = bb
        pen.hdim((-200, ymin), (200, ymin), ymin - 10 * S)
        pen.hdim((-60.5, -95), (60.5, -95), ymin - 17 * S)
        xr = xmax + 10 * S
        _chain_v(pen, [(200, B1[1]), (200, P1[1]), (60.5, 0), (60.5, 45)], xr)
        pen.vdim((200, B1[1]), (60.5, 45), xr + 7 * S)

    pins_front = [("cross", D, 25), ("cross", Gp, 25)]
    pins_top = [("line", (D[0], -80), (D[0], 80)), ("line", (Gp[0], -80), (Gp[0], 80))]
    pins_left = [("line", (-80, D[1]), (80, D[1])), ("line", (-80, Gp[1]), (80, Gp[1]))]
    views = _views(solid, {"front": (front, pins_front), "top": (top, pins_top), "left": (left, pins_left)})

    by = {p.pid: p for p in parts}
    k1, k4 = by["K1"], by["K4"]
    ll = (k1.bbox[0], k1.bbox[1])
    k1_pts = [("P1", P1, "顶板后角"), ("P2", P2, "顶板前角/斗口"), ("T", T, "斗尖"),
              ("B1", B1, "底部/圆弧起点"), ("B2", B2, "圆弧终点"), ("O", AC, f"R{fmt(AR)} 圆心")]
    b1x, b2x = k4.mark_lines[0][0][0], k4.mark_lines[1][0][0]
    k5 = by["K5"]
    cells = [
        part_cell(k1, datum=ll, key_pts=k1_pts, table=True, chain_pts=[P1, P2, T, B1, B2]),
        part_cell(by["K2"]),
        part_cell(by["K3"], note="前缘开 30° 坡口（刃口）；可焊接式斗齿另购"),
        part_cell(k4, chain_pts=[(b1x, 0), (b2x, 0)],
                  note=["两点划线之间卷弧：中性层 R177 / 内 R174（90°）", "线外两段保持平直"]),
        part_cell(k5, datum=D, key_pts=_outline_pts(k5), table=True,
                  hole_notes={50.5: " 装轴套"}),
        part_cell(by["K6"], chain_pts=[(10, 0), (0, 10)], arcs=False, note="直角处 10×10 清角"),
    ]
    purchased = [("KT1", "耳板轴套 Ø50×25", 4, "45#无缝管", "OD50 L25", _tube_mass(50, 30, 25),
                  "焊后镗 Ø30H8")]
    info = dict(name="铲斗焊接总成", no="U17C-01", mass=_mass(parts, purchased), sheet=1,
                total=total_sheets)
    extra = ["耳板内间距 97，与斗杆外宽 95 配合，单侧间隙 1 用垫片调整；两耳 D、G 孔焊后同轴镗。"]
    return SH.build_sheet(path_stub, info, views, cells, _bom_rows(parts, purchased), extra)


# ===========================================================================
# 02 ARM + LINKS
# ===========================================================================

def arm_sheet(path_stub, solid, arm_parts, link_parts, arm_kin, total_sheets):
    A, B, C, E, D = G.ARM_A, G.ARM_B, G.ARM_C, G.ARM_E, G.ARM_D
    by = {p.pid: p for p in arm_parts + link_parts}
    a1 = by["A1"]
    lug_top = (C[0], C[1] + 40)

    def front(pen, bb):
        S = pen.S
        xmin, ymin, xmax, ymax = bb
        y1 = ymin - 10 * S
        _chain_h(pen, [(xmin, B[1]), B, A, C, E, D, (xmax, D[1])], y1)
        pen.hdim((xmin, B[1]), (xmax, D[1]), y1 - 7 * S)
        x1 = xmin - 10 * S
        _chain_v(pen, [(A[0], ymin), A, E, B, C, lug_top], x1)
        pen.vdim((A[0], ymin), lug_top, x1 - 7 * S)
        pen.adim(A, B, 22)
        pen.adim(A, C, -14)
        pen.adim(E, D, 20)
        _pin_note(pen, A, 30, "A 动臂铰点 Ø35H8（焊后镗）", 1, -1)
        _pin_note(pen, D, 25, "D 铲斗铰点 Ø30H8", 1, -1)
        _pin_note(pen, E, 25, "E 连杆铰点 Ø30H8", -1, -1)
        _pin_note(pen, B, 15, "B 斗杆缸杆 Ø30H9", -1, 1)
        _pin_note(pen, C, 15, "C 斗缸缸底 Ø30H9", 1, 1)

    def top(pen, bb):
        S = pen.S
        xmin, ymin, xmax, ymax = bb
        xr = xmax + 10 * S
        _zpair(pen, xr, 47.5, xr, xmax - 20)
        xl = xmin - 10 * S
        _zpair(pen, xl, 57.5, xl, B[0])
        _zpair(pen, xl - 7 * S, 47.5, xl - 7 * S, B[0] - 45)
        _zpair(pen, C[0] + 110, 31, C[0] + 110, C[0])
        _zpair(pen, C[0] + 110 + 7 * S, 43, C[0] + 110 + 7 * S, C[0])
        pen.hdim((xmin, 57.5), (xmax, 47.5), ymin - 10 * S)

    def left(pen, bb):
        S = pen.S
        xmin, ymin, xmax, ymax = bb
        pen.hdim((-47.5, ymin), (47.5, ymin), ymin - 10 * S)
        pen.hdim((-57.5, B[1]), (57.5, B[1]), ymin - 17 * S)
        pen.hdim((-31, C[1]), (31, C[1]), ymin - 24 * S)
        pen.hdim((-43, C[1]), (43, C[1]), ymin - 31 * S)
        pen.vdim((47.5, ymin), (43, ymax), xmax + 10 * S)

    pins = [A, B, C, E, D]
    rr = {A: 30, B: 15, C: 15, E: 25, D: 25}
    views = _views(solid, {
        "front": (front, [("cross", p, rr[p]) for p in pins]),
        "top": (top, [("line", (p[0], -70), (p[0], 70)) for p in pins]),
        "left": (left, [("line", (-70, p[1]), (70, p[1])) for p in pins]),
    })

    a5 = by["A5"]
    cells = [
        part_cell(a1, datum=A, key_pts=_outline_pts(a1), table=True,
                  hole_notes={60.5: " 装轴套A", 50.5: " 装轴套D/E", 28: " 焊后镗Ø30H9"},
                  pairs=[(A, D, 26), (A, B, -20)]),
        part_cell(by["A2"], note="长度按实物修配 ±2（A→D 底边）"),
        part_cell(by["A3"], note=["自 D 端切点起，止于 x=-120；", "其后为斗杆缸杆头窗口，勿封闭"]),
        part_cell(by["A4"], note="B→A 后边全长"),
        part_cell(a5, datum=C, key_pts=_lug_pts(a5, C, 40, (arm_kin['p90'], arm_kin['p220'])), table=True, arcs=False,
                  chain_pts=[p for (_, p, _) in _lug_pts(a5, C, 40, (arm_kin['p90'], arm_kin['p220']))[3:]],
                  hole_notes={28: " 焊后镗Ø30H9"}, ychain=False,
                  extra=lambda pen, bb: pen.rad(C, 40, 160),
                  note="底边随斗杆顶面，按实物修配；两耳内距 62"),
        part_cell(by["A6"], hole_notes={28: " 随侧板镗Ø30H9"}, ring=True),
        part_cell(by["L1"], hole_notes={28: " 铰Ø30H9"}, note="装于斗杆外侧，内距 97"),
        part_cell(by["L2"], hole_notes={28: " 铰Ø30H9"}, note="装于斗耳之间，外宽 95"),
    ]
    purchased = [("AT1", "轴套A Ø60×95", 1, "45#无缝管", "OD60 L95", _tube_mass(60, 35, 95), "焊后镗Ø35H8"),
                 ("AT2", "轴套D/E Ø50×95", 2, "45#无缝管", "OD50 L95", _tube_mass(50, 30, 95), "焊后镗Ø30H8")]
    info = dict(name="斗杆焊接总成 + 连杆", no="U17C-02", mass=_mass(arm_parts, purchased), sheet=2,
                total=total_sheets)
    extra = ["顶板 A3 止于 x=-120，后段为斗杆缸杆头进出窗口；连杆 L1、L2 为单件，不与斗杆焊接。"]
    return SH.build_sheet(path_stub, info, views, cells, _bom_rows(arm_parts + link_parts, purchased), extra)


# ===========================================================================
# 03 BOOM
# ===========================================================================

def boom_sheet(path_stub, solid, parts, boom_kin, total_sheets):
    O, K, A, M, N = G.BOOM_O, G.BOOM_K, G.BOOM_A, G.BOOM_M, G.BOOM_N
    by = {p.pid: p for p in parts}
    b1 = by["B1"]
    u = G.BOOM_KNEE_U
    knee_top = (K[0] + 115 * u[0], K[1] + 115 * u[1])
    knee_bot = (K[0] - 115 * u[0], K[1] - 115 * u[1])
    n_top = (N[0], N[1] + 45)
    bt, bb_ = boom_kin["bend_top_deg"], boom_kin["bend_bot_deg"]

    def front(pen, bb):
        S = pen.S
        xmin, ymin, xmax, ymax = bb
        y1 = ymin - 10 * S
        _chain_h(pen, [(xmin, 0), O, K, M, A, (xmax, 0)], y1)
        pen.hdim((xmin, 0), (xmax, 0), y1 - 7 * S)
        x1 = xmin - 10 * S
        _chain_v(pen, [(O[0], ymin), O, M, K, N, n_top], x1)
        pen.vdim((O[0], ymin), n_top, x1 - 7 * S)
        pen.adim(O, K, 30)
        pen.adim(K, A, 30)
        pen.ang(K, O, A, 70)
        pen.adim(knee_bot, knee_top, -10, text="<>（膝部截面高）")
        pen.vdim((0, -80), (0, 80), 120)
        pen.vdim((A[0], -60), (A[0], 60), A[0] - 110)
        _pin_note(pen, O, 35, "O 根部铰点 Ø40H8（焊后镗）", 1, -1)
        _pin_note(pen, A, 45, "A 斗杆铰点 Ø35H9（焊后镗）", 1, -1)
        _pin_note(pen, M, 17, "M 动臂缸杆 Ø35H9", 1, -1)
        _pin_note(pen, N, 17, "N 斗杆缸底 Ø35H9", 1, 1)
        pen.text("K：膝部中心线交点（构造点）", (K[0] - 6 * S, K[1] - 14 * S), 2.5, "R", "DIM")

    def top(pen, bb):
        S = pen.S
        xmin, ymin, xmax, ymax = bb
        xl = xmin - 10 * S
        _zpair(pen, xl, 58.5, xl, O[0])
        xr = xmax + 10 * S
        _zpair(pen, xr, 70.5, xr, A[0])
        _zpair(pen, xr + 7 * S, 58.5, xr + 7 * S, A[0] - 60)
        _zpair(pen, N[0] + 140, 36, N[0] + 140, N[0])
        _zpair(pen, N[0] + 140 + 7 * S, 52, N[0] + 140 + 7 * S, N[0])
        pen.hdim((xmin, 58.5), (xmax, 70.5), ymin - 10 * S)

    def left(pen, bb):
        S = pen.S
        xmin, ymin, xmax, ymax = bb
        pen.hdim((-58.5, ymin), (58.5, ymin), ymin - 10 * S)
        pen.hdim((-70.5, 0), (70.5, 0), ymin - 17 * S)
        pen.hdim((-36, N[1]), (36, N[1]), ymin - 24 * S)
        pen.hdim((-52, N[1]), (52, N[1]), ymin - 31 * S)
        pen.vdim((58.5, ymin), (52, ymax), xmax + 10 * S)

    pins = [O, A, M, N]
    rr = {O: 35, A: 45, M: 17, N: 17}
    views = _views(solid, {
        "front": (front, [("cross", p, rr[p]) for p in pins]),
        "top": (top, [("line", (p[0], -85), (p[0], 85)) for p in pins]),
        "left": (left, [("line", (-85, p[1]), (85, p[1])) for p in pins]),
    })

    b4, b5 = by["B4"], by["B5"]
    b2, b3 = by["B2"], by["B3"]
    cells = [
        part_cell(b1, datum=O, key_pts=_outline_pts(b1), table=True,
                  hole_notes={70.5: " 装根部轴套", 33: " 焊后镗Ø35H9"}),
        part_cell(b2, chain_pts=[(b2.mark_lines[0][0][0], 0), (b2.mark_lines[1][0][0], 0)],
                  note=[f"两点划线之间压弯 {bt:.1f}°，内 R24，K=0.4", "展开料，压弯后与侧板顶边对合"]),
        part_cell(b3, chain_pts=[(b3.mark_lines[0][0][0], 0), (b3.mark_lines[1][0][0], 0)],
                  note=[f"两点划线之间压弯 {bb_:.1f}°，内 R24，K=0.4（外表面为弯曲内侧）",
                        "展开料，压弯后与侧板腹边对合"]),
        part_cell(b4, datum=M, key_pts=_lug_pts(b4, M, 45, (boom_kin['pM1'], boom_kin['pM2'])), table=True, arcs=False,
                  chain_pts=[p for (_, p, _) in _lug_pts(b4, M, 45, (boom_kin['pM1'], boom_kin['pM2']))[3:]],
                  hole_notes={33: " 焊后镗Ø35H9"}, ychain=False, extra=lambda pen, bb: pen.rad(M, 45, 250),
                  note="上边随动臂腹板轮廓（含膝部 R24）；两耳内距 72"),
        part_cell(b5, datum=N, key_pts=_lug_pts(b5, N, 45, (boom_kin['pN1'], boom_kin['pN2'])), table=True, arcs=False,
                  chain_pts=[p for (_, p, _) in _lug_pts(b5, N, 45, (boom_kin['pN1'], boom_kin['pN2']))[3:]],
                  hole_notes={33: " 焊后镗Ø35H9"}, ychain=False, extra=lambda pen, bb: pen.rad(N, 45, 15),
                  note="底边随动臂顶板轮廓（含膝部 R36）；两耳内距 72"),
        part_cell(by["B6"], hole_notes={33: " 随侧板镗Ø35H9"}, ring=True),
    ]
    purchased = [("BT1", "根部轴套 Ø70×117", 1, "45#无缝管", "OD70 L117", _tube_mass(70, 40, 117),
                  "焊后镗Ø40H8")]
    info = dict(name="动臂焊接总成", no="U17C-03", mass=_mass(parts, purchased), sheet=3,
                total=total_sheets)
    extra = [f"顶板 B2、底板 B3 为整板压弯（顶 {bt:.1f}°、底 {bb_:.1f}°，内 R24），压弯后与侧板对合再施焊。"]
    return SH.build_sheet(path_stub, info, views, cells, _bom_rows(parts, purchased), extra)
