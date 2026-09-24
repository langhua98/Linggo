#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
geom.py -- all design numbers, 2D geometry helpers (tangent_chain etc.) and the
raw point/frame definitions for arm (斗杆), bucket (铲斗) and boom (动臂/大臂).

Nothing here writes files; this module is pure data + math, imported by
parts.py / kinematics.py / model3d.py / sheets.py.
"""

import math
from shapely.geometry import Point, Polygon, LineString

STEEL_DENSITY = 7.85e-3  # g / mm^3  (7.85 g/cm^3)
MATERIAL = "Q355B"

REPORT_LINES = []  # collected for stdout + BOM notes


def log(*a):
    s = " ".join(str(x) for x in a)
    print(s)
    REPORT_LINES.append(s)


# ===========================================================================
# vector helpers
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


def vmid(a, b):
    return ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)


# ===========================================================================
# tangent_chain (unchanged core algorithm from spec v1)
# ===========================================================================

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
            h = r * math.cos(sweep / 2)   # < 0 for arcs over 180 deg: centre on the bulge side
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


def rect_verts(length, width):
    return [(0.0, 0.0, 0.0), (length, 0.0, 0.0), (length, width, 0.0), (0.0, width, 0.0)]


def transform_pts(pts, ang_rad, dx, dy):
    return [vadd(rot(p, ang_rad), (dx, dy)) for p in pts]


def transform_verts(verts, ang_rad, dx, dy):
    """rotate+translate a bulge-vertex ring; bulge sign is preserved under
    rigid transforms that don't mirror (pure rotation is fine)."""
    return [(*vadd(rot((x, y), ang_rad), (dx, dy)), b) for (x, y, b) in verts]


# ===========================================================================
# ARM (斗杆) frame -- spec v2: A at origin, D on +x axis, +y = cylinder side
# ===========================================================================

ARM_A = (0.0, 0.0)
ARM_B = (-290.0, 70.0)     # arm-cylinder ROD eye, moved
ARM_C = (150.0, 165.0)     # bucket-cylinder BASE eye, moved
ARM_E = (800.0, 12.0)      # arm-link pivot, moved
ARM_D = (950.0, 0.0)       # bucket pivot

# ===========================================================================
# BUCKET (铲斗) frame -- unchanged from v1 -- D at local origin
# ===========================================================================

BKT_D = (0.0, 0.0)
BKT_G = (-131.56, -47.88)
BKT_T = (450 * math.cos(math.radians(-70)), 450 * math.sin(math.radians(-70)))
BKT_P1 = (-200.0, -95.0)
BKT_P2 = (80.0, -95.0)
BKT_B1 = (-10.0, -450.0)
BKT_ARC_C = (-10.0, -270.0)
BKT_ARC_R = 180.0
BKT_B2 = (-190.0, -270.0)

# ===========================================================================
# BOOM (动臂/大臂) frame -- NEW -- foot pin O at origin, arm pin A on +x axis
# ===========================================================================

BOOM_O = (0.0, 0.0)
OK_LEN = 1050.0
KA_LEN = 920.0
ANGLE_K_DEG = 130.0  # interior angle O-K-A

_cosK = math.cos(math.radians(ANGLE_K_DEG))
_OA = math.sqrt(OK_LEN ** 2 + KA_LEN ** 2 - 2 * OK_LEN * KA_LEN * _cosK)
BOOM_A = (_OA, 0.0)
# angle of K as seen from O (law of cosines in triangle O-K-A)
_cosAngleO = (OK_LEN ** 2 + _OA ** 2 - KA_LEN ** 2) / (2 * OK_LEN * _OA)
_angleO = math.acos(max(-1.0, min(1.0, _cosAngleO)))
BOOM_K = (OK_LEN * math.cos(_angleO), OK_LEN * math.sin(_angleO))

BOOM_M = (1000.0, 221.0)   # boom-cylinder ROD eye (belly lugs, B4)
BOOM_N = (1000.0, 670.0)   # arm-cylinder BASE eye (top lugs, B5)

# knee outward bisector direction u: bisector of the two segment outward normals
_dir_OK = math.atan2(BOOM_K[1] - BOOM_O[1], BOOM_K[0] - BOOM_O[0])
_dir_KA = math.atan2(BOOM_A[1] - BOOM_K[1], BOOM_A[0] - BOOM_K[0])
_n1 = _dir_OK + math.pi / 2.0   # outward normal of O->K (rotate +90)
_n2 = _dir_KA + math.pi / 2.0   # outward normal of K->A (rotate +90)
_u_ang = (_n1 + _n2) / 2.0
BOOM_KNEE_U = (math.cos(_u_ang), math.sin(_u_ang))
BOOM_KNEE_U_DEG = math.degrees(_u_ang)

BOOM_CT = vadd(BOOM_K, vscale(BOOM_KNEE_U, 115.0 - 36.0))   # top knee circle centre R36
BOOM_CB = vsub(BOOM_K, vscale(BOOM_KNEE_U, 115.0 + 24.0))   # belly knee circle centre R24 (concave)

BOOM_BEND_INNER_R = 24.0
BOOM_BEND_ANGLE_DEG = 50.0
BOOM_K_FACTOR = 0.4


# ===========================================================================
# bulge-path utilities (sub-paths of outlines, analytic lug outlines)
# ===========================================================================

def arc_of(a, b, bulge):
    """Centre, radius, start angle and signed sweep of the arc a->b with bulge."""
    sweep = 4 * math.atan(bulge)
    c = vlen(vsub(b, a))
    r = c / 2 / math.sin(abs(sweep) / 2)
    m = vmid(a, b)
    u = vunit(vsub(b, a))
    n = (-u[1], u[0])
    h = r * math.cos(abs(sweep) / 2) * (1 if bulge > 0 else -1)
    cen = vadd(m, vscale(n, h))
    a0 = math.atan2(a[1] - cen[1], a[0] - cen[0])
    return cen, r, a0, sweep


def _locate(verts, p, tol=1e-4):
    n = len(verts)
    for i in range(n):
        a = verts[i][:2]
        b = verts[(i + 1) % n][:2]
        bl = verts[i][2]
        if abs(bl) < 1e-12:
            L = vlen(vsub(b, a))
            if L < 1e-12:
                continue
            t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / L ** 2
            q = vadd(a, vscale(vsub(b, a), t))
            if -1e-9 <= t <= 1 + 1e-9 and vlen(vsub(q, p)) < tol:
                return i, t
        else:
            cen, r, a0, sw = arc_of(a, b, bl)
            if abs(vlen(vsub(p, cen)) - r) > tol:
                continue
            ap = math.atan2(p[1] - cen[1], p[0] - cen[0])
            d = (ap - a0) % (2 * math.pi) if sw > 0 else (a0 - ap) % (2 * math.pi)
            if d <= abs(sw) + 1e-9:
                return i, d / abs(sw)
    raise ValueError(f"point {p} not on outline")


def sub_path(verts, P, Q):
    """Open bulge path along a closed outline from P to Q (traversal order).
    Returns [(x, y, bulge), ...] ending with (Q, 0)."""
    n = len(verts)
    iP, tP = _locate(verts, P)
    iQ, tQ = _locate(verts, Q)

    def part_bulge(i, t0, t1):
        bl = verts[i][2]
        if abs(bl) < 1e-12:
            return 0.0
        sw = 4 * math.atan(bl)
        return math.tan(sw * (t1 - t0) / 4)

    out = []
    if iP == iQ and tP <= tQ:
        out.append((P[0], P[1], part_bulge(iP, tP, tQ)))
    else:
        out.append((P[0], P[1], part_bulge(iP, tP, 1.0)))
        i = (iP + 1) % n
        while i != iQ:
            out.append(verts[i])
            i = (i + 1) % n
        out.append((verts[iQ][0], verts[iQ][1], part_bulge(iQ, 0.0, tQ)))
    out.append((Q[0], Q[1], 0.0))
    return [v for k, v in enumerate(out) if k == 0 or vlen(vsub(v[:2], out[k - 1][:2])) > 1e-6]


def path_length(path):
    L = 0.0
    for k in range(len(path) - 1):
        a, b, bl = path[k][:2], path[k + 1][:2], path[k][2]
        if abs(bl) < 1e-12:
            L += vlen(vsub(b, a))
        else:
            _, r, _, sw = arc_of(a, b, bl)
            L += r * abs(sw)
    return L


def reverse_path(path):
    pts = [v[:2] for v in path][::-1]
    bl = [v[2] for v in path[:-1]][::-1]
    return [(p[0], p[1], -b) for p, b in zip(pts, bl)] + [(pts[-1][0], pts[-1][1], 0.0)]


def _tangent_pts(p, c, r):
    d = vlen(vsub(p, c))
    phi = math.atan2(p[1] - c[1], p[0] - c[0])
    al = math.acos(r / d)
    return [vadd(c, (r * math.cos(phi + s * al), r * math.sin(phi + s * al))) for s in (1, -1)]


def _cross(u, v):
    return u[0] * v[1] - u[1] * v[0]


def lug_outline(parent_verts, c, r, P, Q):
    """Exact (line+arc) outline of a lug standing on the parent plate edge:
    convex hull of circle (c, r) and base points P, Q, whose base follows the
    parent outline between P and Q.  CCW bulge ring."""
    s1, s2 = sub_path(parent_verts, P, Q), sub_path(parent_verts, Q, P)
    sub = s1 if path_length(s1) < path_length(s2) else s2
    first, second = sub[0][:2], sub[-1][:2]
    base = reverse_path(sub)            # second -> first, lug on the left
    t1 = [t for t in _tangent_pts(first, c, r) if _cross(vsub(t, first), vsub(c, first)) > 0][0]
    t2 = [t for t in _tangent_pts(second, c, r) if _cross(vsub(second, t), vsub(c, t)) > 0][0]
    a1 = math.atan2(t1[1] - c[1], t1[0] - c[0])
    a2 = math.atan2(t2[1] - c[1], t2[0] - c[0])
    sweep = (a2 - a1) % (2 * math.pi)
    ring = base[:-1] + [(first[0], first[1], 0.0), (t1[0], t1[1], math.tan(sweep / 4)),
                        (t2[0], t2[1], 0.0)]
    return ring, dict(t1=t1, t2=t2, first=first, second=second)
