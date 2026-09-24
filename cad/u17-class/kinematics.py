#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
kinematics.py -- arm-level bucket-curl kinematics (unchanged method from v1,
new pin coordinates) + machine-level boom/arm/bucket forward kinematics,
cylinder stroke/moment-arm/clearance checks and the dig envelope (spec v2 S4).
"""

import math
from shapely.geometry import Point, Polygon, LineString
from shapely.ops import unary_union

import geom as G
from geom import vsub, vadd, vscale, vlen, vunit, rot, flatten_bulge_ring


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
    return (G.ARM_D[0] + 140 * math.cos(gr), G.ARM_D[1] + 140 * math.sin(gr))


def bucket_point_in_arm_frame(p_local, g_deg):
    """p_arm = D + Rot(g-160deg) . (p.x, -p.y)"""
    mirrored = (p_local[0], -p_local[1])
    rotated = rot(mirrored, math.radians(g_deg - 160.0))
    return vadd(G.ARM_D, rotated)


_BUCKET_OUTLINE_LOCAL = [
    (G.BKT_P1[0], G.BKT_P1[1], 0.0), (G.BKT_P2[0], G.BKT_P2[1], 0.0), (G.BKT_T[0], G.BKT_T[1], 0.0),
    (G.BKT_B1[0], G.BKT_B1[1], -math.tan(math.radians(90) / 4.0)), (G.BKT_B2[0], G.BKT_B2[1], 0.0),
]


def transformed_bucket_polygon(g_deg):
    pts = flatten_bulge_ring(_BUCKET_OUTLINE_LOCAL, chord=0.3)
    return Polygon([bucket_point_in_arm_frame(p, g_deg) for p in pts])


def bucket_tip_in_arm_frame(g_deg):
    return bucket_point_in_arm_frame(G.BKT_T, g_deg)


def cylinder_capsule(p0, p1, r_barrel, split_from_p0, r_rod):
    d = vsub(p1, p0)
    L = vlen(d)
    u = vunit(d)
    split = min(split_from_p0, L)
    mid = vadd(p0, vscale(u, split))
    geoms = [LineString([p0, mid]).buffer(r_barrel, cap_style=1)]
    if L > split:
        geoms.append(LineString([mid, p1]).buffer(r_rod, cap_style=1))
    return unary_union(geoms)


def perp_dist_point_to_line(pt, p1, p2):
    d = vsub(p2, p1)
    L = vlen(d)
    if L < 1e-9:
        return vlen(vsub(pt, p1))
    u = vunit(d)
    w = vsub(pt, p1)
    cross = w[0] * u[1] - w[1] * u[0]
    return abs(cross)


# ===========================================================================
# ARM-LEVEL: bucket curl kinematics (v1 method, v2 pin coordinates)
# ===========================================================================

def arm_level_kinematics(poly_a1, a3_strip_poly=None):
    C, E, D = G.ARM_C, G.ARM_E, G.ARM_D
    arm_minus_hub = poly_a1.difference(Point(D).buffer(55.0))

    rows = []
    for gi in range(-100, 131):
        g = float(gi)
        Ga = G_arm_of(g)
        sol = circle_intersection(E, 230.0, Ga, 210.0)
        if sol is None:
            continue
        p1, p2 = sol
        J = p1 if p1[1] > p2[1] else p2
        L = vlen(vsub(C, J))
        v1 = vsub(E, J)
        v2 = vsub(Ga, J)
        dot = v1[0] * v2[0] + v1[1] * v2[1]
        m1, m2 = vlen(v1), vlen(v2)
        ang = math.degrees(math.acos(max(-1.0, min(1.0, dot / (m1 * m2)))))
        okL = 560.0 <= L <= 860.0
        okAng = 35.0 <= ang <= 145.0
        rows.append(dict(g=g, J=J, L=L, ang=ang, okL=okL, okAng=okAng, ok=okL and okAng))

    reach = [r for r in rows if r["okL"]]
    if not reach:
        raise RuntimeError("No g value satisfies the 560-860mm bucket-cylinder stroke window")
    g_min = min(r["g"] for r in reach)
    g_max = max(r["g"] for r in reach)
    min_ang = min(r["ang"] for r in reach)
    min_ang_g = [r["g"] for r in reach if r["ang"] == min_ang][0]

    min_moment_arm = None
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
        cap = cylinder_capsule(C, r["J"], 34.0, 470.0, 15.0)
        cap = cap.union(Point(r["J"]).buffer(25.0))
        clr = cap.distance(poly_a1)
        if clr <= 0:
            clr = -cap.intersection(poly_a1).area ** 0.5
        if min_clear is None or clr < min_clear:
            min_clear = clr
        ma = perp_dist_point_to_line(D, C, r["J"])
        if min_moment_arm is None or ma < min_moment_arm:
            min_moment_arm = ma

    tip_min = g_min - 90.0
    tip_max = g_max - 90.0

    # -- curl limit governance: cylinder-extended vs bucket-touches-arm(<10mm clearance) --
    clearance_ok = [r for r in reach if True]
    # at g_min (cylinder fully extended end of stroke) bucket/arm clearance:
    bpoly_gmin = transformed_bucket_polygon(g_min)
    clr_at_gmin = bpoly_gmin.distance(arm_minus_hub)
    cyl_limited = clr_at_gmin >= 10.0
    if cyl_limited:
        governs = "缸伸出到位 (560~860mm行程用尽)"
    else:
        governs = f"斗体与斗杆间隙不足10mm (实际{clr_at_gmin:.1f}mm)，先于油缸行程到位"

    rod_window = None
    if a3_strip_poly is not None:
        # report rod-direction-at-B range is computed by machine_kinematics (needs phi range);
        # here we just keep the hook available.
        pass

    report = dict(
        g_min=g_min, g_max=g_max, span=g_max - g_min,
        tip_min=tip_min, tip_max=tip_max,
        min_transmission_angle=min_ang, min_transmission_angle_g=min_ang_g,
        min_cyl_arm_clearance=min_clear, max_bucket_arm_overlap=max_overlap,
        min_bucket_arm_clearance=min_bclr, min_bucket_moment_arm=min_moment_arm,
        curl_limit_clearance_at_gmin=clr_at_gmin, curl_limit_governs=governs,
        rows=rows, reach=reach, arm_minus_hub=arm_minus_hub,
    )
    return report


def build_a3_strip_polygon(seg_DB, p_cut, poly_a1, thickness=10.0):
    """Thin in-plane footprint of the A3 top plate: a `thickness`-wide strip
    along the D-tangent-point -> p_cut segment, offset OUTWARD from the arm
    interior (away from poly_a1's centroid)."""
    p0 = seg_DB[0]
    d = vsub(p_cut, p0)
    L = vlen(d)
    u = vunit(d)
    n = (-u[1], u[0])
    c = poly_a1.centroid
    # decide outward sign: outward = away from centroid
    mid = vadd(p0, vscale(u, L / 2.0))
    if (vsub(mid, (c.x, c.y))[0] * n[0] + vsub(mid, (c.x, c.y))[1] * n[1]) < 0:
        n = (-n[0], -n[1])
    p0o = vadd(p0, vscale(n, thickness))
    p1o = vadd(p_cut, vscale(n, thickness))
    return Polygon([p0, p_cut, p1o, p0o])


# ===========================================================================
# MACHINE-LEVEL: boom + arm + bucket forward kinematics (spec v2 S4)
# ===========================================================================

MACHINE_O = (420.0, 480.0)
MACHINE_P = vadd(MACHINE_O, (150.0, -250.0))  # boom-cylinder base, on swing bracket
THETA_RANGE = (-50.0, 72.0)
PHI_RANGE = (-170.0, -45.0)

BOOM_CYL_CLOSED, BOOM_CYL_STROKE = 755.0, 510.0
ARM_CYL_CLOSED, ARM_CYL_STROKE = 750.0, 530.0
BUCKET_CYL_CLOSED, BUCKET_CYL_STROKE = 560.0, 300.0

REF_U17_DEPTH = 2300.0
REF_U17_REACH = 3570.0


def boom_to_machine(p_boom_local, theta_deg):
    th = math.radians(theta_deg)
    return vadd(MACHINE_O, rot(p_boom_local, th))


def arm_local_to_boom_local(p_arm_local, phi_deg):
    ph = math.radians(phi_deg)
    return vadd(G.BOOM_A, rot(p_arm_local, ph))


def arm_local_to_machine(p_arm_local, theta_deg, phi_deg):
    p_boom = arm_local_to_boom_local(p_arm_local, phi_deg)
    return boom_to_machine(p_boom, theta_deg)


def bucket_local_to_machine(p_bkt_local, theta_deg, phi_deg, g_deg):
    p_arm = bucket_point_in_arm_frame(p_bkt_local, g_deg)
    return arm_local_to_machine(p_arm, theta_deg, phi_deg)


def machine_kinematics(poly_a1, poly_b1, arm_report):
    lines = []

    # ---- boom cylinder: base P (machine, fixed) -> rod eye M (on boom) ----
    theta_grid = [THETA_RANGE[0] + i * 0.5 for i in range(int((THETA_RANGE[1] - THETA_RANGE[0]) / 0.5) + 1)]
    boom_L = []
    for th in theta_grid:
        M_m = boom_to_machine(G.BOOM_M, th)
        L = vlen(vsub(MACHINE_P, M_m))
        boom_L.append((th, L))
    boom_Lmin = min(boom_L, key=lambda x: x[1])
    boom_Lmax = max(boom_L, key=lambda x: x[1])
    theta_feasible = [th for (th, L) in boom_L if BOOM_CYL_CLOSED <= L <= BOOM_CYL_CLOSED + BOOM_CYL_STROKE]
    boom_fits = len(theta_feasible) > 0 and (boom_Lmin[1] >= BOOM_CYL_CLOSED - 1e-6 or True)
    lines.append(f"动臂缸 O-P-M: 行程范围 {BOOM_CYL_CLOSED:.0f}~{BOOM_CYL_CLOSED+BOOM_CYL_STROKE:.0f}mm; "
                 f"theta在[{THETA_RANGE[0]:.0f},{THETA_RANGE[1]:.0f}]deg扫描得缸长 {boom_Lmin[1]:.1f}"
                 f"(theta={boom_Lmin[0]:.1f}) ~ {boom_Lmax[1]:.1f}mm(theta={boom_Lmax[0]:.1f})")
    if theta_feasible:
        lines.append(f"  -> 缸行程可覆盖的theta子区间: [{min(theta_feasible):.1f}, {max(theta_feasible):.1f}] deg")
    else:
        lines.append("  -> [WARN] 全theta范围内动臂缸长度都不在行程内！")

    # moment arm about O over theta range
    boom_ma = [perp_dist_point_to_line(MACHINE_O, MACHINE_P, boom_to_machine(G.BOOM_M, th)) for th in theta_grid]
    boom_ma_min = min(boom_ma)
    lines.append(f"  动臂缸对O点最小力臂: {boom_ma_min:.1f} mm")

    # ---- arm cylinder: N (boom) -> rod eye B (on arm), length depends on phi only ----
    phi_grid = [PHI_RANGE[0] + i * 0.5 for i in range(int((PHI_RANGE[1] - PHI_RANGE[0]) / 0.5) + 1)]
    arm_L = []
    for ph in phi_grid:
        B_boom = arm_local_to_boom_local(G.ARM_B, ph)
        L = vlen(vsub(G.BOOM_N, B_boom))
        arm_L.append((ph, L))
    arm_Lmin = min(arm_L, key=lambda x: x[1])
    arm_Lmax = max(arm_L, key=lambda x: x[1])
    phi_feasible = [ph for (ph, L) in arm_L if ARM_CYL_CLOSED <= L <= ARM_CYL_CLOSED + ARM_CYL_STROKE]
    lines.append(f"臂缸 N-B: 行程范围 {ARM_CYL_CLOSED:.0f}~{ARM_CYL_CLOSED+ARM_CYL_STROKE:.0f}mm; "
                 f"phi在[{PHI_RANGE[0]:.0f},{PHI_RANGE[1]:.0f}]deg扫描得缸长 {arm_Lmin[1]:.1f}"
                 f"(phi={arm_Lmin[0]:.1f}) ~ {arm_Lmax[1]:.1f}mm(phi={arm_Lmax[0]:.1f})")
    if phi_feasible:
        lines.append(f"  -> 缸行程可覆盖的phi子区间: [{min(phi_feasible):.1f}, {max(phi_feasible):.1f}] deg")
    else:
        lines.append("  -> [WARN] 全phi范围内臂缸长度都不在行程内！")

    arm_ma = [perp_dist_point_to_line(G.BOOM_A, G.BOOM_N, arm_local_to_boom_local(G.ARM_B, ph)) for ph in phi_grid]
    arm_ma_min = min(arm_ma)
    lines.append(f"  臂缸对A(动臂-斗杆铰点)最小力臂: {arm_ma_min:.1f} mm")

    # ---- bucket cylinder: already computed in arm_report (C -> J vs g) ----
    lines.append(f"斗缸 C-J: 行程范围 {BUCKET_CYL_CLOSED:.0f}~{BUCKET_CYL_CLOSED+BUCKET_CYL_STROKE:.0f}mm; "
                 f"可达g范围 [{arm_report['g_min']:.0f},{arm_report['g_max']:.0f}]deg (见斗杆级运动学)；"
                 f"对D点最小力臂 {arm_report['min_bucket_moment_arm']:.1f} mm")

    # ---- arm-cylinder capsule clearance to boom polygon & arm polygon ------
    min_clr_to_boom = None
    min_clr_to_arm = None
    for ph in phi_grid:
        B_boom = arm_local_to_boom_local(G.ARM_B, ph)
        cap_boom = cylinder_capsule(G.BOOM_N, B_boom, 40.0, 700.0, 18.0)
        clr_b = cap_boom.distance(poly_b1)
        if min_clr_to_boom is None or clr_b < min_clr_to_boom:
            min_clr_to_boom = clr_b
        # same capsule expressed in ARM-local frame: transform N into arm-local
        N_arm_local = rot(vsub(G.BOOM_N, G.BOOM_A), -math.radians(ph))
        cap_arm = cylinder_capsule(N_arm_local, G.ARM_B, 40.0, 700.0, 18.0)
        clr_a = cap_arm.distance(poly_a1)
        if min_clr_to_arm is None or clr_a < min_clr_to_arm:
            min_clr_to_arm = clr_a
    lines.append(f"臂缸胶囊体(R40/前700mm, R18/余下)与动臂侧板最小间隙: {min_clr_to_boom:.1f} mm")
    lines.append(f"臂缸胶囊体与斗杆侧板最小间隙: {min_clr_to_arm:.1f} mm")

    # ---- boom-cylinder capsule clearance to boom polygon --------------------
    min_clr_boomcyl = None
    for th in theta_grid:
        P_boom_local = rot(vsub(MACHINE_P, MACHINE_O), -math.radians(th))
        cap = cylinder_capsule(P_boom_local, G.BOOM_M, 40.0, 700.0, 18.0)
        clr = cap.distance(poly_b1)
        if min_clr_boomcyl is None or clr < min_clr_boomcyl:
            min_clr_boomcyl = clr
    lines.append(f"动臂缸胶囊体(假设R40/前700mm,R18/余下,半径未在原文给出、沿用臂缸同款假设)"
                 f"与动臂侧板最小间隙: {min_clr_boomcyl:.1f} mm")

    # ---- A3 rod-window check: rod direction at B over feasible phi ---------
    rod_angles = []
    for ph in phi_feasible if phi_feasible else phi_grid:
        N_arm_local = rot(vsub(G.BOOM_N, G.BOOM_A), -math.radians(ph))
        d = vsub(G.ARM_B, N_arm_local)
        rod_angles.append(math.degrees(math.atan2(d[1], d[0])))
    rod_ang_min, rod_ang_max = min(rod_angles), max(rod_angles)
    lines.append(f"臂缸杆在B处方向角(臂系,对可行phi范围): {rod_ang_min:.1f} ~ {rod_ang_max:.1f} deg")

    return dict(
        lines=lines,
        theta_grid=theta_grid, boom_L=boom_L, theta_feasible=theta_feasible,
        boom_ma_min=boom_ma_min,
        phi_grid=phi_grid, arm_L=arm_L, phi_feasible=phi_feasible,
        arm_ma_min=arm_ma_min,
        min_clr_arm_cyl_to_boom=min_clr_to_boom, min_clr_arm_cyl_to_arm=min_clr_to_arm,
        min_clr_boom_cyl_to_boom=min_clr_boomcyl,
        rod_angle_range=(rod_ang_min, rod_ang_max),
        boom_L_range=(boom_Lmin[1], boom_Lmax[1]), arm_L_range=(arm_Lmin[1], arm_Lmax[1]),
    )


def compute_envelope(arm_report, machine_report, theta_step=2.0, phi_step=2.0, g_step=3.0):
    theta_feasible = machine_report["theta_feasible"] or [t for (t, _) in machine_report["boom_L"]]
    phi_feasible = machine_report["phi_feasible"] or [p for (p, _) in machine_report["arm_L"]]
    g_feasible = sorted(set(r["g"] for r in arm_report["reach"]))

    def thin(seq, step):
        seq = sorted(seq)
        out = [seq[0]]
        for v in seq[1:]:
            if v - out[-1] >= step - 1e-6:
                out.append(v)
        if out[-1] != seq[-1]:
            out.append(seq[-1])
        return out

    thetas = thin(theta_feasible, theta_step)
    phis = thin(phi_feasible, phi_step)
    gs = thin(g_feasible, g_step)

    max_reach = -1e18
    max_reach_pt = None
    max_reach_ground = -1e18
    max_reach_ground_pt = None
    min_tip_y = 1e18
    min_tip_y_pt = None
    max_tip_y = -1e18
    max_tip_y_pt = None
    max_D_height = -1e18

    tip_points = []
    for th in thetas:
        D_m = arm_local_to_machine(G.ARM_D, th, phis[0])
        # D height doesn't depend on phi/g at all except via theta (D is on arm,
        # so it DOES depend on phi too -- recompute inside phi loop below).
        for ph in phis:
            D_m2 = arm_local_to_machine(G.ARM_D, th, ph)
            if D_m2[1] > max_D_height:
                max_D_height = D_m2[1]
            for g in gs:
                tip = bucket_local_to_machine(G.BKT_T, th, ph, g)
                tip_points.append(tip)
                if tip[0] > max_reach:
                    max_reach, max_reach_pt = tip[0], tip
                if abs(tip[1]) < 15.0 and tip[0] > max_reach_ground:
                    max_reach_ground, max_reach_ground_pt = tip[0], tip
                if tip[1] < min_tip_y:
                    min_tip_y, min_tip_y_pt = tip[1], tip
                if tip[1] > max_tip_y:
                    max_tip_y, max_tip_y_pt = tip[1], tip

    dump_height = max_D_height - 450.0

    report = dict(
        thetas=thetas, phis=phis, gs=gs, tip_points=tip_points,
        max_reach=max_reach, max_reach_pt=max_reach_pt,
        max_reach_ground=max_reach_ground, max_reach_ground_pt=max_reach_ground_pt,
        max_dig_depth=-min_tip_y, max_dig_depth_pt=min_tip_y_pt,
        max_dig_height=max_tip_y, max_dig_height_pt=max_tip_y_pt,
        max_D_height=max_D_height, dump_height=dump_height,
    )
    return report


def check_a3_window(arm_kin, phi_feasible):
    """A3 top plate covers the D-tangent-point .. x=-120 (arm frame) portion of
    the D->B tangent line; x<-120 is left open as the arm-cylinder rod window.
    Check that the rod segment (N -> B, expressed in the arm's own local frame
    for every feasible boom-relative arm angle phi) never crosses the A3
    plate's in-plane footprint."""
    a3_poly = build_a3_strip_polygon(arm_kin["seg_DB"], arm_kin["p_cut"], arm_kin["poly_a1"])
    hits = 0
    min_clear = None
    for ph in phi_feasible:
        N_arm_local = rot(vsub(G.BOOM_N, G.BOOM_A), -math.radians(ph))
        rod = LineString([N_arm_local, G.ARM_B])
        d = rod.distance(a3_poly)
        if min_clear is None or d < min_clear:
            min_clear = d
        if rod.intersects(a3_poly):
            hits += 1
    return dict(a3_poly=a3_poly, hits=hits, n_checked=len(phi_feasible), min_clear=min_clear)
