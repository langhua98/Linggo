#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
model3d.py -- CadQuery weldments (bucket / arm / boom) -> STEP.

Z is the lateral (out-of-plane) axis, symmetric about z=0, matching the 2D
part frames used in geom.py/parts.py (X,Y = the side-view plane). Bolt-on
strip plates whose spec-v2 instruction is "outer face on the outline,
thickness inward" are built by offsetting the relevant outline path inward
by the plate thickness (shapely single-sided buffer) and extruding; bent
plates (K4 wrap, B2/B3 press-brake plates) are modelled directly in their
BENT (in-service) shape as a rim just inside the side-plate outline along the actual
bent centreline path, rather than as a flat blank -- this is the physically
correct 3D shape for the assembly (the flat blank only matters for the 2D
laser/press-brake drawing, produced separately in parts.py/sheets.py).
"""

import math
import os

import cadquery as cq
from shapely.geometry import Polygon, LineString, Point
from shapely.ops import unary_union

import geom as G
from geom import vsub, vadd, vscale, vlen, vunit, rot, flatten_bulge_ring


# ===========================================================================
# generic solid-building helpers
# ===========================================================================

def _wire_from_pts(pts):
    return cq.Workplane("XY").polyline(pts).close()


def _simplify(poly: Polygon, tol=0.4):
    """Reduce vertex count (arcs were flattened at 0.1mm chord for the CUT
    layer, far finer than needed for a 3D validity/mass check) so OCC
    booleans stay fast. Simplifies the outer ring AND each hole ring
    separately (shapely's own simplify can drop small holes outright)."""
    outer = Polygon(poly.exterior).simplify(tol, preserve_topology=True)
    if outer.is_empty or outer.geom_type != "Polygon":
        return poly
    holes = []
    for h in poly.interiors:
        hp = Polygon(h).simplify(max(tol, 0.3), preserve_topology=True)
        if not hp.is_empty and hp.geom_type == "Polygon" and hp.exterior.length > 1.0:
            holes.append(list(hp.exterior.coords))
    return Polygon(list(outer.exterior.coords), holes)


def extrude_polygon_z(poly: Polygon, z0, z1):
    """Extrude a shapely polygon (X,Y) along Z in [z0,z1]. Handles holes."""
    poly = _simplify(poly)
    outer = list(poly.exterior.coords)[:-1]
    solid = _wire_from_pts(outer).extrude(z1 - z0)
    if abs(z0) > 1e-9:
        solid = solid.translate((0, 0, z0))
    for hole in poly.interiors:
        hpts = list(hole.coords)[:-1]
        hole_solid = _wire_from_pts(hpts).extrude(z1 - z0)
        if abs(z0) > 1e-9:
            hole_solid = hole_solid.translate((0, 0, z0))
        solid = solid.cut(hole_solid)
    return solid


def cylinder_z(cx, cy, d, z0, z1):
    r = d / 2.0
    return (cq.Workplane("XY").workplane(offset=z0).moveTo(cx, cy)
            .circle(r).extrude(z1 - z0))


def tube_z(cx, cy, od, idd, z0, z1):
    r_o, r_i = od / 2.0, idd / 2.0
    outer = (cq.Workplane("XY").workplane(offset=z0).moveTo(cx, cy)
             .circle(r_o).extrude(z1 - z0))
    inner = (cq.Workplane("XY").workplane(offset=z0).moveTo(cx, cy)
             .circle(r_i).extrude(z1 - z0))
    return outer.cut(inner)


def offset_strip_from_path(path_pts, thickness, ref_poly, z0, z1, chord=1.0):
    """Build a thickness-wide solid strip whose OUTER face lies on `path_pts`
    (a polyline in the parent XY frame) and whose material extends INWARD
    (toward ref_poly's interior) by `thickness`, extruded over [z0,z1]."""
    ls = LineString(path_pts)
    u0 = vunit(vsub(path_pts[1], path_pts[0]))
    left_n = (-u0[1], u0[0])
    c = ref_poly.centroid
    mid = path_pts[len(path_pts) // 2]
    toward_c = vsub((c.x, c.y), mid)
    inward_is_left = (left_n[0] * toward_c[0] + left_n[1] * toward_c[1]) > 0
    dist = thickness if inward_is_left else -thickness
    band = ls.buffer(dist, single_sided=True, cap_style=2, join_style=2)
    if band.geom_type == "MultiPolygon":
        band = max(band.geoms, key=lambda gg: gg.area)
    return extrude_polygon_z(_simplify(band, 0.2), z0, z1)


def _sketch(verts, z0):
    """CadQuery wire from a closed bulge ring (true arcs), on plane z=z0."""
    wp = cq.Workplane("XY", origin=(0, 0, z0)).moveTo(verts[0][0], verts[0][1])
    n = len(verts)
    for i in range(n):
        a = verts[i][:2]
        b = verts[(i + 1) % n][:2]
        bl = verts[i][2]
        if abs(bl) < 1e-12:
            if i < n - 1:
                wp = wp.lineTo(b[0], b[1])
        else:
            cen, r, a0, sw = G.arc_of(a, b, bl)
            am = a0 + sw / 2
            wp = wp.threePointArc((cen[0] + r * math.cos(am), cen[1] + r * math.sin(am)), (b[0], b[1]))
    return wp.close()


def extrude_bulge(verts, holes, z0, z1):
    """Plate solid from a bulge outline with true arcs + round holes."""
    solid = _sketch(verts, z0).extrude(z1 - z0)
    for (cx, cy, d) in holes:
        solid = solid.cut(cylinder_z(cx, cy, d, z0 - 1, z1 + 1))
    return solid


def rim_band(verts, t, keep_pts, z0, z1):
    """Plate of thickness t lying just inside the outline `verts` (exact arcs:
    outline minus its inward offset), trimmed to the polygon `keep_pts`."""
    outer = _sketch(verts, z0).extrude(z1 - z0)
    inner = _sketch(verts, z0).offset2D(-t, kind="arc").extrude(z1 - z0)
    keep = cq.Workplane("XY", origin=(0, 0, z0)).polyline(keep_pts).close().extrude(z1 - z0)
    return outer.cut(inner).intersect(keep)


def union_all(solids):
    out = solids[0]
    for s in solids[1:]:
        out = out.union(s)
    return out


def mirror_z(solid):
    return solid.mirror(mirrorPlane="XY")


# ===========================================================================
# BUCKET (bucket frame, NOT mirrored) -- literal boxes/paths per spec S5
# ===========================================================================

def build_bucket_solid(bkt_parts_by_id, poly_k1):
    D0, G0, T0 = G.BKT_D, G.BKT_G, G.BKT_T
    P1, P2, B1, B2 = G.BKT_P1, G.BKT_P2, G.BKT_B1, G.BKT_B2
    ARC_C, ARC_R = G.BKT_ARC_C, G.BKT_ARC_R

    solids = []

    # K1 sides x2, z in ±[192,200], t8 -- extrude the K1 profile itself
    for sgn in (+1, -1):
        z0, z1 = sgn * 192.0, sgn * 200.0
        z0, z1 = min(z0, z1), max(z0, z1)
        solids.append(extrude_bulge(bkt_parts_by_id["K1"].outer, [], z0, z1))

    # K2 top plate: literal box x in[-200,80], y in[-103,-95], z in ±192
    k2poly = Polygon([(-200, -103), (80, -103), (80, -95), (-200, -95)])
    solids.append(extrude_polygon_z(k2poly, -192.0, 192.0))

    # K3 cutting edge t12: on inner side of T->B1, from T, 110 long, z ±192
    u = vunit(vsub(B1, T0))
    left_n = (-u[1], u[0])  # pick inward via centroid test below
    p_end = vadd(T0, vscale(u, 110.0))
    c = poly_k1.centroid
    mid = vadd(T0, vscale(u, 55.0))
    toward_c = vsub((c.x, c.y), mid)
    inward = 12.0 if (left_n[0] * toward_c[0] + left_n[1] * toward_c[1]) > 0 else -12.0
    k3band = LineString([T0, p_end]).buffer(inward, single_sided=True, cap_style=2, join_style=2)
    if k3band.geom_type == "MultiPolygon":
        k3band = max(k3band.geoms, key=lambda gg: gg.area)
    solids.append(extrude_polygon_z(k3band, -192.0, 192.0))

    # K4 wrap plate: 6 mm rim just inside the side profile, from the blade end
    # round the bottom arc and up the back wall to P1 (exact arcs)
    n_out = (-left_n[0], -left_n[1]) if inward > 0 else left_n
    keep = [vadd(p_end, vscale(n_out, 30)), vadd(p_end, vscale(n_out, -80)), ARC_C,
            (P1[0] + 80, P1[1]), (P1[0] - 40, P1[1]), (P1[0] - 60, B1[1] - 60),
            (p_end[0], B1[1] - 60)]
    solids.append(rim_band(bkt_parts_by_id["K1"].outer, 6.0, keep, -192.0, 192.0))

    # K5 ear plates x2, t12, z in ±[48.5,60.5]
    k5 = bkt_parts_by_id["K5"]
    for sgn in (+1, -1):
        z0, z1 = sorted((sgn * 48.5, sgn * 60.5))
        solids.append(extrude_bulge(k5.outer, k5.holes, z0, z1))
    # ear bosses OD50/ID30 z ±[48.5,73.5]
    for sgn in (+1, -1):
        z0, z1 = sorted((sgn * 48.5, sgn * 73.5))
        solids.append(tube_z(D0[0], D0[1], 50.0, 30.0, z0, z1))
        solids.append(tube_z(G0[0], G0[1], 50.0, 30.0, z0, z1))

    # K6 gussets (t8, legs 60): stand on the top plate (y=-95) against the OUTER
    # face of each ear (z=+-60.5), one pair at x=-80 and one at x=+20.
    for xc in (-80.0, 20.0):
        for sgn in (+1, -1):
            zf = sgn * 60.5
            tri = (cq.Workplane("YZ", origin=(xc - 4.0, 0, 0))
                   .polyline([(-95.0, zf), (-95.0, zf + sgn * 60.0), (-35.0, zf)])
                   .close().extrude(8.0))
            solids.append(tri)

    solid = union_all(solids)
    return solid


def vmid(a, b):
    return ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)


# ===========================================================================
# ARM (arm frame)
# ===========================================================================

def build_arm_solid(arm_parts_by_id, arm_kin):
    A, D, B = G.ARM_A, G.ARM_D, G.ARM_B
    poly_a1 = arm_kin["poly_a1"]
    solids = []

    # A1 sides x2, z ±[37.5,47.5]
    for sgn in (+1, -1):
        z0, z1 = sorted((sgn * 37.5, sgn * 47.5))
        solids.append(extrude_bulge(arm_parts_by_id["A1"].outer, arm_parts_by_id["A1"].holes, z0, z1))

    # A2 bottom plate t12, along A->D, outer face on outline, inward, z ±37.5
    seg_AD = arm_kin["seg_AD"]
    solids.append(offset_strip_from_path(list(seg_AD), 12.0, poly_a1, -37.5, 37.5))

    # A3 top plate t10, along D-tangent -> x=-120 point (window), z ±37.5
    seg_DB = arm_kin["seg_DB"]
    p_cut = arm_kin["p_cut"]
    solids.append(offset_strip_from_path([seg_DB[0], p_cut], 10.0, poly_a1, -37.5, 37.5))

    # A4 rear plate t10, full B->A, z ±37.5
    seg_BA = arm_kin["seg_BA"]
    solids.append(offset_strip_from_path(list(seg_BA), 10.0, poly_a1, -37.5, 37.5))

    # bosses: A OD60 L95 (ID35 bore), D & E OD50 L95 (ID30 bore)
    solids.append(tube_z(A[0], A[1], 60.0, 35.0, -47.5, 47.5))
    solids.append(tube_z(D[0], D[1], 50.0, 30.0, -47.5, 47.5))
    solids.append(tube_z(G.ARM_E[0], G.ARM_E[1], 50.0, 30.0, -47.5, 47.5))

    # A6 rings x2, z ±[47.5,57.5]
    for sgn in (+1, -1):
        z0, z1 = sorted((sgn * 47.5, sgn * 57.5))
        solids.append(tube_z(B[0], B[1], 70.0, 28.0, z0, z1))

    # A5 lugs x2, t12, z ±[31,43], on top
    a5 = arm_parts_by_id["A5"]
    for sgn in (+1, -1):
        z0, z1 = sorted((sgn * 31.0, sgn * 43.0))
        solids.append(extrude_bulge(a5.outer, a5.holes, z0, z1))

    solid = union_all(solids)
    return solid


# ===========================================================================
# BOOM (boom frame)
# ===========================================================================

def build_boom_solid(boom_parts_by_id, boom_kin):
    O, Aj, M, N = G.BOOM_O, G.BOOM_A, G.BOOM_M, G.BOOM_N
    poly_b1 = boom_kin["poly_b1"]
    solids = []

    b1 = boom_parts_by_id["B1"]
    for sgn in (+1, -1):
        z0, z1 = sorted((sgn * 48.5, sgn * 58.5))
        solids.append(extrude_bulge(b1.outer, b1.holes, z0, z1))

    # B2 top / B3 belly: 12 mm rims just inside the side outline (exact bend radii),
    # trimmed at the tangent points next to the O and A end circles
    K, Ct, Cb, u = G.BOOM_K, G.BOOM_CT, G.BOOM_CB, G.BOOM_KNEE_U

    def _normal_pts(p, q, inward_ref):
        d = vunit(vsub(q, p))
        n = (-d[1], d[0])
        if (n[0] * (inward_ref[0] - p[0]) + n[1] * (inward_ref[1] - p[1])) < 0:
            n = (-n[0], -n[1])
        return vadd(p, vscale(n, 60)), vadd(p, vscale(n, -30))  # (inside, outside)

    tA, tO = boom_kin["seg_A_Ct"][0], boom_kin["seg_Ct_O"][1]
    a_in, a_out = _normal_pts(tA, boom_kin["seg_A_Ct"][1], K)
    o_in, o_out = _normal_pts(tO, boom_kin["seg_Ct_O"][0], K)
    keep_top = [a_in, a_out, vadd(Ct, vscale(u, 150)), o_out, o_in, K]
    solids.append(rim_band(b1.outer, 12.0, keep_top, -48.5, 48.5))

    bO, bA = boom_kin["seg_O_Cb"][0], boom_kin["seg_Cb_A"][1]
    o_in, o_out = _normal_pts(bO, boom_kin["seg_O_Cb"][1], K)
    a_in, a_out = _normal_pts(bA, boom_kin["seg_Cb_A"][0], K)
    keep_bot = [o_in, o_out, vsub(Cb, vscale(u, 150)), a_out, a_in, K]
    solids.append(rim_band(b1.outer, 12.0, keep_bot, -48.5, 48.5))

    # foot boss OD70 ID40 L117 (z ±58.5)
    solids.append(tube_z(O[0], O[1], 70.0, 40.0, -58.5, 58.5))

    # B6 rings x2, z ±[58.5,70.5], OD90 ID33 (bore 35 after H9 finish; use 35 for through-bore clearance)
    for sgn in (+1, -1):
        z0, z1 = sorted((sgn * 58.5, sgn * 70.5))
        solids.append(tube_z(Aj[0], Aj[1], 90.0, 35.0, z0, z1))
    # A pivot bore through B1 sides and rings (subtracted after the union)
    bore_A = cylinder_z(Aj[0], Aj[1], 35.0, -71.0, 71.0)

    # B4/B5 lugs x2, t16, z ±[36,52]
    for pid in ("B4", "B5"):
        lp = boom_parts_by_id[pid]
        for sgn in (+1, -1):
            z0, z1 = sorted((sgn * 36.0, sgn * 52.0))
            solids.append(extrude_bulge(lp.outer, lp.holes, z0, z1))

    return union_all(solids).cut(bore_A)


def _arc_pts_between(p1, p2, centre, nseg=24):
    a1 = math.atan2(p1[1] - centre[1], p1[0] - centre[0])
    a2 = math.atan2(p2[1] - centre[1], p2[0] - centre[0])
    r = vlen(vsub(p1, centre))
    da = (a2 - a1)
    while da <= -math.pi:
        da += 2 * math.pi
    while da > math.pi:
        da -= 2 * math.pi
    pts = []
    for k in range(0, nseg + 1):
        a = a1 + da * k / nseg
        pts.append((centre[0] + r * math.cos(a), centre[1] + r * math.sin(a)))
    return pts


# ===========================================================================
# export + mass cross-check
# ===========================================================================

def export_step_and_check(solid, path, part_list, label):
    is_valid = solid.val().isValid()
    vol_mm3 = solid.val().Volume()
    mass_kg = vol_mm3 * G.STEEL_DENSITY / 1000.0
    sum_mass_kg = sum(p.mass_kg_each() * p.qty for p in part_list)
    diff_pct = (mass_kg - sum_mass_kg) / sum_mass_kg * 100.0 if sum_mass_kg else float("nan")
    cq.exporters.export(solid, path)
    G.log(f"[3D] {label}: solid valid={is_valid}, volume={vol_mm3/1000.0:.1f} cm^3, "
          f"mass(3D)={mass_kg:.2f} kg vs sum(2D parts)={sum_mass_kg:.2f} kg  (diff {diff_pct:+.1f}%)")
    return dict(valid=is_valid, volume_mm3=vol_mm3, mass_3d_kg=mass_kg, mass_2d_sum_kg=sum_mass_kg,
                diff_pct=diff_pct, path=path)
