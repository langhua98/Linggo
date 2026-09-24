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
BENT (in-service) shape as a thickness-wide swept band along the actual
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


def swept_band_from_path(path_pts, thickness, z0, z1):
    """Centreline-swept band of the given width, extruded over [z0,z1].
    Used for BENT plates (K4 wrap, B2/B3) where we model the actual bent
    3D shape rather than the flat blank (see module docstring)."""
    ls = LineString(path_pts)
    band = ls.buffer(thickness / 2.0, cap_style=2, join_style=2)
    if band.geom_type == "MultiPolygon":
        band = max(band.geoms, key=lambda gg: gg.area)
    return extrude_polygon_z(_simplify(band, 0.2), z0, z1)


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
        solids.append(extrude_polygon_z(poly_k1, z0, z1))

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

    # K4 wrap plate: 6mm band along blade-end -> B1 -> arc -> B2 -> P1, z ±192
    arc_pts = []
    a1 = math.atan2(B1[1] - ARC_C[1], B1[0] - ARC_C[0])
    a2 = math.atan2(B2[1] - ARC_C[1], B2[0] - ARC_C[0])
    da = -((a1 - a2) % (2 * math.pi))  # CW sweep matching bulge convention
    nseg = 48
    for k in range(nseg + 1):
        a = a1 + da * k / nseg
        arc_pts.append((ARC_C[0] + ARC_R * math.cos(a), ARC_C[1] + ARC_R * math.sin(a)))
    k4_path = [p_end, B1] + arc_pts[1:] + [P1]
    solids.append(swept_band_from_path(k4_path, 6.0, -192.0, 192.0))

    # K5 ear plates x2, t12, z in ±[48.5,60.5]
    ear_poly = bkt_parts_by_id["K5"].polygon
    for sgn in (+1, -1):
        z0, z1 = sorted((sgn * 48.5, sgn * 60.5))
        solids.append(extrude_polygon_z(ear_poly, z0, z1))
    # ear bosses OD50/ID30 z ±[48.5,73.5]
    for sgn in (+1, -1):
        z0, z1 = sorted((sgn * 48.5, sgn * 73.5))
        solids.append(tube_z(D0[0], D0[1], 50.0, 30.0, z0, z1))
        solids.append(tube_z(G0[0], G0[1], 50.0, 30.0, z0, z1))

    # K6 gussets: triangle legs 60 in YZ plane, t8 centred at x=-80,+20, sitting on top plate (y=-95)
    for xc in (-80.0, 20.0):
        for zc in (-192.0 + 30.0, 192.0 - 30.0):
            tri = (cq.Workplane("YZ", origin=(xc - 4.0, 0, 0))
                   .polyline([(-95.0, zc - 30.0), (-95.0, zc + 30.0), (-95.0 + 60.0, zc - 30.0)])
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
        solids.append(extrude_polygon_z(poly_a1, z0, z1))

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
    lug_poly = arm_parts_by_id["A5"].polygon
    for sgn in (+1, -1):
        z0, z1 = sorted((sgn * 31.0, sgn * 43.0))
        solids.append(extrude_polygon_z(lug_poly, z0, z1))

    solid = union_all(solids)
    return solid


# ===========================================================================
# BOOM (boom frame)
# ===========================================================================

def build_boom_solid(boom_parts_by_id, boom_kin):
    O, Aj, M, N = G.BOOM_O, G.BOOM_A, G.BOOM_M, G.BOOM_N
    poly_b1 = boom_kin["poly_b1"]
    solids = []

    # B1 sides x2, z ±[48.5,58.5]
    for sgn in (+1, -1):
        z0, z1 = sorted((sgn * 48.5, sgn * 58.5))
        solids.append(extrude_polygon_z(poly_b1, z0, z1))

    # B2 top plate t12: bent band along A->Ct(arc)->O top path, z ±48.5
    top_path = [boom_kin["seg_A_Ct"][0]] + _arc_pts_between(boom_kin["seg_A_Ct"][1], boom_kin["seg_Ct_O"][0],
                                                              G.BOOM_CT) + [boom_kin["seg_Ct_O"][1]]
    solids.append(swept_band_from_path(top_path, 12.0, -48.5, 48.5))

    # B3 bottom (belly) plate t12: bent band along O->Cb(arc)->A path, z ±48.5
    bot_path = [boom_kin["seg_O_Cb"][0]] + _arc_pts_between(boom_kin["seg_O_Cb"][1], boom_kin["seg_Cb_A"][0],
                                                              G.BOOM_CB) + [boom_kin["seg_Cb_A"][1]]
    solids.append(swept_band_from_path(bot_path, 12.0, -48.5, 48.5))

    # foot boss OD70 ID40 L117 (z ±58.5)
    solids.append(tube_z(O[0], O[1], 70.0, 40.0, -58.5, 58.5))

    # B6 rings x2, z ±[58.5,70.5], OD90 ID33 (bore 35 after H9 finish; use 35 for through-bore clearance)
    for sgn in (+1, -1):
        z0, z1 = sorted((sgn * 58.5, sgn * 70.5))
        solids.append(tube_z(Aj[0], Aj[1], 90.0, 35.0, z0, z1))
    # A pivot bore through B1 sides too: cut a 35-dia hole through full width to keep it a clean through-bore
    solids.append(cylinder_z(Aj[0], Aj[1], 35.0, -70.5, 70.5))

    # B4/B5 lugs x2, t16, z ±[36,52]
    for pid in ("B4", "B5"):
        poly = boom_parts_by_id[pid].polygon
        for sgn in (+1, -1):
            z0, z1 = sorted((sgn * 36.0, sgn * 52.0))
            solids.append(extrude_polygon_z(poly, z0, z1))

    solid = solids[0]
    for s in solids[1:-1]:
        solid = solid.union(s)
    # cut the through-bore last (subtract) then continue unioning remaining if any
    solid = solid.cut(solids[-1]) if len(solids) > 0 else solid
    return solid


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
    for k in range(1, nseg):
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
