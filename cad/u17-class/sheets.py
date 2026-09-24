#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sheets.py -- GB-style A1 drawing sheets: left block = assembly 3-views (OCC
HLR from the model3d.py solids, visible/hidden/centre lines), right block =
that weldment's flat laser parts in part-number order with labels, plus a
title block, 明细栏 (BOM table) and 技术要求 (tech-requirement) note block.

Exports <name>.dxf (audit clean), <name>.pdf and preview/<name>.png.
"""

import math
import os

import ezdxf
import ezdxf.fonts.fonts as ezfonts
from ezdxf.addons.drawing import RenderContext, Frontend
from ezdxf.addons.drawing import matplotlib as ezmpl
from ezdxf.addons.drawing.config import Configuration, LineweightPolicy, BackgroundPolicy

from shapely.geometry import Point

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

import geom as G
from geom import vsub, vadd, vscale, vlen, vunit, flatten_bulge_ring, translate_verts, translate_holes

from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape
from OCP.HLRAlgo import HLRAlgo_Projector
from OCP.gp import gp_Ax2, gp_Pnt, gp_Dir
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_EDGE
from OCP.TopoDS import TopoDS
from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.GCPnts import GCPnts_UniformDeflection

WQY_DIR = "/usr/share/fonts/truetype/wqy"
_FONT_READY = False


def ensure_font():
    global _FONT_READY
    if not _FONT_READY:
        ezfonts.font_manager.build(folders=[WQY_DIR])
        _FONT_READY = True


FRAME_W_A1, FRAME_H_A1 = 841.0, 594.0
SCALES = (2.0, 2.5, 4.0, 5.0)

LAYER_DEFS = [
    ("FRAME", 7, "Continuous"), ("TITLE", 7, "Continuous"),
    ("VIEW", 7, "Continuous"), ("HIDDEN", 1, "DASHED"), ("CENTER", 5, "CENTER"),
    ("DIM", 4, "Continuous"), ("BOM", 7, "Continuous"), ("NOTE", 7, "Continuous"),
    ("CUT", 7, "Continuous"), ("MARK", 3, "Continuous"),
]


def new_sheet_doc():
    ensure_font()
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 4
    doc.header["$MEASUREMENT"] = 1
    if "CJK" not in doc.styles:
        doc.styles.add("CJK", font="wqy-zenhei.ttc")
    doc.styles.get("Standard").dxf.font = "wqy-zenhei.ttc"
    for name, color, lt in LAYER_DEFS:
        if name not in doc.layers:
            doc.layers.add(name, color=color, linetype=lt)
    return doc


def setup_dimstyle(doc, name, scale):
    if name not in doc.dimstyles:
        doc.dimstyles.new(name, dxfattribs={
            "dimtxt": 2.5 * scale, "dimasz": 1.8 * scale, "dimexo": 1.2 * scale,
            "dimexe": 1.2 * scale, "dimtad": 1, "dimclrt": 4, "dimclrd": 4,
            "dimclre": 4, "dimdec": 1, "dimscale": scale, "dimtxsty": "CJK",
        })
    return name


def txt(msp, s, pos, h, layer="NOTE", style="CJK", align="LEFT", rotation=0.0, color=None):
    attribs = {"layer": layer, "height": h, "style": style, "rotation": rotation}
    if color is not None:
        attribs["color"] = color
    e = msp.add_text(s, dxfattribs=attribs)
    from ezdxf.enums import TextEntityAlignment
    amap = {"LEFT": TextEntityAlignment.LEFT, "CENTER": TextEntityAlignment.MIDDLE_CENTER,
            "RIGHT": TextEntityAlignment.RIGHT, "MC": TextEntityAlignment.MIDDLE_CENTER}
    e.set_placement(pos, align=amap.get(align, TextEntityAlignment.LEFT))
    return e


# ===========================================================================
# HLR three-view extraction
# ===========================================================================

VIEW_DEFS = {
    # name: (normal(look direction), x_direction)  -- local (x,y) of the HLR
    # output is exactly the 2D projection in this Ax2 frame.
    "front": ((0.0, 0.0, 1.0), (1.0, 0.0, 0.0)),    # local: (X,Y)
    "top":   ((0.0, -1.0, 0.0), (1.0, 0.0, 0.0)),   # local: (X,Z)
    "left":  ((1.0, 0.0, 0.0), (0.0, 0.0, -1.0)),   # local: (-Z,Y)
}


def _edges_to_polylines(comp, deflection=0.5):
    out = []
    if comp.IsNull():
        return out
    exp = TopExp_Explorer(comp, TopAbs_EDGE)
    while exp.More():
        e = TopoDS.Edge_s(exp.Current())
        try:
            curve = BRepAdaptor_Curve(e)
            gc = GCPnts_UniformDeflection(curve, deflection)
            n = gc.NbPoints()
            if n >= 2:
                pts = [(gc.Value(i).X(), gc.Value(i).Y()) for i in range(1, n + 1)]
                out.append(pts)
        except Exception:
            pass
        exp.Next()
    return out


def hlr_view(shape_wrapped, view_name):
    normal, xdir = VIEW_DEFS[view_name]
    ax2 = gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(*normal), gp_Dir(*xdir))
    projector = HLRAlgo_Projector(ax2)
    algo = HLRBRep_Algo()
    algo.Add(shape_wrapped)
    algo.Projector(projector)
    algo.Update()
    algo.Hide()
    h2s = HLRBRep_HLRToShape(algo)
    visible = _edges_to_polylines(h2s.VCompound()) + _edges_to_polylines(h2s.OutLineVCompound()) \
        + _edges_to_polylines(h2s.Rg1LineVCompound())
    hidden = _edges_to_polylines(h2s.HCompound()) + _edges_to_polylines(h2s.OutLineHCompound())
    return visible, hidden


def polylines_bbox(*polyline_lists):
    xs, ys = [], []
    for pls in polyline_lists:
        for pl in pls:
            for (x, y) in pl:
                xs.append(x)
                ys.append(y)
    if not xs:
        return (0, 0, 0, 0)
    return (min(xs), min(ys), max(xs), max(ys))


def draw_polylines(msp, pls, dx, dy, layer):
    for pl in pls:
        if len(pl) < 2:
            continue
        pts = [(x + dx, y + dy) for (x, y) in pl]
        msp.add_lwpolyline(pts, dxfattribs={"layer": layer})


def add_centerline(msp, p1, p2, ext, layer="CENTER"):
    u = vunit(vsub(p2, p1))
    a = vsub(p1, vscale(u, ext))
    b = vadd(p2, vscale(u, ext))
    msp.add_line(a, b, dxfattribs={"layer": layer})


def add_center_cross(msp, c, r, layer="CENTER"):
    ext = r + 4.0
    msp.add_line((c[0] - ext, c[1]), (c[0] + ext, c[1]), dxfattribs={"layer": layer})
    msp.add_line((c[0], c[1] - ext), (c[0], c[1] + ext), dxfattribs={"layer": layer})


# ===========================================================================
# BOM table + tech-requirement block (shared)
# ===========================================================================

TECH_NOTES = [
    "1. 先点焊定位，复核外形及孔位无误后再满焊；焊缝按图示位置，未注明焊角尺寸均取板厚的0.7倍。",
    "2. 标注\"焊后镗孔/线镗\"之处必须待相应零件整体组焊完成后一次性镗孔，保证同轴度。",
    "3. 切割面（激光/火焰）去毛刺、去氧化皮，尖角倒钝R1~2。",
    "4. 未注公差尺寸按 GB/T 1804-m 级执行；未注形位公差按 GB/T 1184-K 级执行。",
    "5. 承力焊缝（箱形梁、耳板）为本设计推算所得，正式上机前须由结构工程师复核并做疲劳强度校核。",
    "6. 涂装前应除锈至 Sa2.5 级，涂刷防锈底漆一道、面漆两道（本设计不含涂装工艺细节）。",
]

DISCLAIMER = ("尺寸按公开参数推算的自主设计，非久保田原厂图纸；承力件上机前请结构工程师复核；"
              "设计: Claude 自主设计·非原厂")


def draw_bom_table(msp, parts, origin, scale, title="明细栏"):
    """明细栏: 序号/代号/名称/数量/材料/厚度/单重kg/总重kg/备注"""
    ox, oy = origin
    row_h = 7.0 * scale
    cols = [("序号", 10), ("代号", 14), ("名称", 26), ("数量", 10), ("材料", 22),
            ("厚度", 10), ("单重kg", 14), ("总重kg", 14), ("备注", 46)]
    col_w = [c[1] * scale for c in cols]
    total_w = sum(col_w)
    n_rows = len(parts) + 1
    total_h = row_h * n_rows
    # outer box
    msp.add_lwpolyline([(ox, oy), (ox + total_w, oy), (ox + total_w, oy + total_h), (ox, oy + total_h)],
                        close=True, dxfattribs={"layer": "BOM"})
    # header row + rows separators
    for r in range(n_rows + 1):
        y = oy + total_h - r * row_h
        msp.add_line((ox, y), (ox + total_w, y), dxfattribs={"layer": "BOM"})
    xcur = ox
    for w in col_w:
        msp.add_line((xcur, oy), (xcur, oy + total_h), dxfattribs={"layer": "BOM"})
        xcur += w
    msp.add_line((xcur, oy), (xcur, oy + total_h), dxfattribs={"layer": "BOM"})

    th = 2.2 * scale
    xcur = ox
    y_hdr = oy + total_h - row_h / 2.0
    for (name, w) in cols:
        txt(msp, name, (xcur + w * scale / 2.0, y_hdr), th, layer="BOM", align="MC")
        xcur += w * scale
    total_mass_all = 0.0
    for i, p in enumerate(parts):
        y = oy + total_h - row_h * (i + 1) - row_h / 2.0
        each = p.mass_kg_each()
        tot = each * p.qty
        total_mass_all += tot
        vals = [str(i + 1), p.pid, p.name_cn, f"x{p.qty}", p.material, f"{p.thickness}",
                f"{each:.2f}", f"{tot:.2f}", p.bom_note[:26] + ("…" if len(p.bom_note) > 26 else "")]
        xcur = ox
        for (val, (_, w)) in zip(vals, cols):
            txt(msp, val, (xcur + w * scale / 2.0, y), th * 0.85, layer="BOM", align="MC")
            xcur += w * scale
    txt(msp, title, (ox, oy + total_h + 3.0 * scale), 3.0 * scale, layer="BOM")
    return total_w, total_h, total_mass_all


def draw_tech_block(msp, origin, scale, extra_notes=None):
    ox, oy = origin
    lines = ["技术要求："] + TECH_NOTES + (extra_notes or []) + ["", DISCLAIMER]
    lh = 2.6 * scale
    y = oy
    for i, ln in enumerate(lines):
        h = 2.4 * scale if i > 0 else 3.0 * scale
        txt(msp, ln, (ox, y - i * lh), h, layer="NOTE")
    return len(lines) * lh


# ===========================================================================
# Title block
# ===========================================================================

def draw_title_block(msp, frame_w, frame_h, scale, drawing_no, name_cn, sheet_no, sheet_total,
                      total_mass_kg):
    tb_w = 180.0 * scale
    tb_h = 56.0 * scale
    x0 = frame_w - 5.0 * scale - tb_w
    y0 = 5.0 * scale
    rows = [
        ("图名", name_cn), ("图号", drawing_no), ("材料", G.MATERIAL),
        ("比例", f"1:{scale:g}"), ("单件/总重", f"{total_mass_kg:.1f} kg"),
        ("设计", "Claude 自主设计·非原厂"), ("日期", "2026-09-24"),
        ("图幅", f"第 {sheet_no} 张 共 {sheet_total} 张"),
    ]
    n = len(rows)
    row_h = tb_h / n
    msp.add_lwpolyline([(x0, y0), (x0 + tb_w, y0), (x0 + tb_w, y0 + tb_h), (x0, y0 + tb_h)],
                        close=True, dxfattribs={"layer": "TITLE"})
    label_w = 34.0 * scale
    for i, (k, v) in enumerate(rows):
        y = y0 + tb_h - i * row_h
        msp.add_line((x0, y - row_h), (x0 + tb_w, y - row_h), dxfattribs={"layer": "TITLE"})
        msp.add_line((x0 + label_w, y), (x0 + label_w, y - row_h), dxfattribs={"layer": "TITLE"})
        txt(msp, k, (x0 + 2.0 * scale, y - row_h * 0.65), 2.6 * scale, layer="TITLE")
        txt(msp, str(v), (x0 + label_w + 2.0 * scale, y - row_h * 0.65), 2.6 * scale, layer="TITLE")
    # first-angle projection symbol (simplified schematic) + label, left of title block
    sym_cx = x0 - 22.0 * scale
    sym_cy = y0 + tb_h * 0.35
    r1, r2 = 5.0 * scale, 8.5 * scale
    msp.add_circle((sym_cx - 9 * scale, sym_cy), r1 * 0.55, dxfattribs={"layer": "TITLE"})
    msp.add_line((sym_cx - 9 * scale + r1 * 0.55, sym_cy), (sym_cx + 9 * scale - r2 * 0.55, sym_cy - 0),
                  dxfattribs={"layer": "TITLE"})
    msp.add_lwpolyline([(sym_cx + 3 * scale, sym_cy - r2 * 0.5), (sym_cx + 9 * scale, sym_cy - r2 * 0.75),
                         (sym_cx + 9 * scale, sym_cy + r2 * 0.75), (sym_cx + 3 * scale, sym_cy + r2 * 0.5)],
                        close=True, dxfattribs={"layer": "TITLE"})
    txt(msp, "第一角画法 (GB/T 14692)", (sym_cx - 9 * scale, sym_cy - 8 * scale), 2.4 * scale, layer="TITLE")
    return x0, y0, tb_w, tb_h


def draw_frame(doc, scale):
    msp = doc.modelspace()
    W, H = FRAME_W_A1 * scale, FRAME_H_A1 * scale
    # outer paper edge
    msp.add_lwpolyline([(0, 0), (W, 0), (W, H), (0, H)], close=True, dxfattribs={"layer": "FRAME"})
    # inner frame: 25mm*S left (binding), 10mm*S others, scaled by drawing scale
    left, right, top, bot = 25.0 * scale, 10.0 * scale, 10.0 * scale, 10.0 * scale
    msp.add_lwpolyline([(left, bot), (W - right, bot), (W - right, H - top), (left, H - top)],
                        close=True, dxfattribs={"layer": "FRAME"})
    return W, H, (left, bot, W - right, H - top)


# ===========================================================================
# per-part flat layout (right block)
# ===========================================================================

def pack_layout(parts, max_row_width, gap):
    cursor_x, cursor_y, row_h = 0.0, 0.0, 0.0
    offsets = {}
    for p in parts:
        minx, miny, maxx, maxy = p.bbox
        w, h = maxx - minx, maxy - miny
        if cursor_x > 0 and cursor_x + w > max_row_width:
            cursor_x = 0.0
            cursor_y += row_h + gap
            row_h = 0.0
        offsets[p.pid] = (cursor_x - minx, cursor_y - miny)
        cursor_x += w + gap
        row_h = max(row_h, h)
    total_h = cursor_y + row_h
    return offsets, total_h


def add_part_geometry(msp, part, dx, dy, scale, dimstyle):
    outer = translate_verts(part.outer, dx, dy)
    pl = msp.add_lwpolyline(outer, format="xyb", dxfattribs={"layer": "CUT"})
    pl.closed = True
    holes_t = translate_holes(part.holes, dx, dy)
    for (cx, cy, d) in holes_t:
        msp.add_circle((cx, cy), d / 2.0, dxfattribs={"layer": "CUT"})
        add_center_cross(msp, (cx, cy), d / 2.0)

    minx, miny, maxx, maxy = part.bbox
    minx, miny, maxx, maxy = minx + dx, miny + dy, maxx + dx, maxy + dy
    h = 2.5 * scale
    mark_pt = part.polygon.representative_point()
    mx, my = mark_pt.x + dx, mark_pt.y + dy
    txt(msp, f"{part.pid} {part.name_cn}", (mx, my + h), h, layer="MARK", align="MC")
    txt(msp, f"t{part.thickness} x{part.qty} {part.material}", (mx, my - h * 0.6), h * 0.85,
        layer="MARK", align="MC")
    for (x, y, note) in part.mark_notes:
        txt(msp, note, (x + dx, y + dy), 1.8 * scale, layer="MARK")
    for (p1, p2) in part.mark_lines:
        msp.add_line((p1[0] + dx, p1[1] + dy), (p2[0] + dx, p2[1] + dy),
                      dxfattribs={"layer": "MARK", "linetype": "DASHDOT"})

    dimo = 8.0 * scale
    try:
        d = msp.add_aligned_dim(p1=(minx, miny), p2=(maxx, miny), distance=-dimo,
                                 dimstyle=dimstyle, dxfattribs={"layer": "DIM"})
        d.render()
    except Exception:
        pass
    try:
        d = msp.add_aligned_dim(p1=(minx, miny), p2=(minx, maxy), distance=-dimo,
                                 dimstyle=dimstyle, dxfattribs={"layer": "DIM"})
        d.render()
    except Exception:
        pass
    for (cx, cy, dia) in holes_t:
        try:
            d = msp.add_diameter_dim(center=(cx, cy), radius=dia / 2.0, angle=45,
                                      dimstyle=dimstyle, dxfattribs={"layer": "DIM"})
            d.render()
        except Exception:
            pass
    if len(holes_t) >= 2:
        h1 = (holes_t[0][0], holes_t[0][1])
        h2 = (holes_t[1][0], holes_t[1][1])
        try:
            d = msp.add_aligned_dim(p1=h1, p2=h2, distance=dimo * 0.8,
                                     dimstyle=dimstyle, dxfattribs={"layer": "DIM"})
            d.render()
        except Exception:
            pass
    return (minx, miny, maxx, maxy)


# ===========================================================================
# Chinese view/part labels + PDF/PNG rendering
# ===========================================================================

def render_pdf_png(doc, base_path_noext, W, H, dpi=200):
    ensure_font()
    matplotlib.rcParams["font.sans-serif"] = ["WenQuanYi Zen Hei"]
    matplotlib.rcParams["axes.unicode_minus"] = False
    msp = doc.modelspace()
    cfg = Configuration(lineweight_policy=LineweightPolicy.RELATIVE, background_policy=BackgroundPolicy.WHITE)
    ctx = RenderContext(doc)
    aspect = H / W
    fig_w = 34.0
    fig, ax = plt.subplots(figsize=(fig_w, fig_w * aspect))
    ax.set_xlim(-0.01 * W, 1.01 * W)
    ax.set_ylim(-0.01 * H, 1.01 * H)
    ax.set_aspect("equal")
    ax.axis("off")
    out = ezmpl.MatplotlibBackend(ax)
    Frontend(ctx, out, config=cfg).draw_layout(msp, finalize=True)
    fig.tight_layout(pad=0.1)
    fig.savefig(base_path_noext + ".pdf")
    fig.savefig(base_path_noext + ".png", dpi=dpi)
    plt.close(fig)


# ===========================================================================
# 3D vector helpers for pin projection
# ===========================================================================

def _v3sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _v3dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _v3cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _v3unit(a):
    l = math.sqrt(_v3dot(a, a))
    return (a[0] / l, a[1] / l, a[2] / l)


def project_pt(p3, view_name):
    normal, xdir = VIEW_DEFS[view_name]
    xdir = _v3unit(xdir)
    normal = _v3unit(normal)
    ydir = _v3cross(normal, xdir)
    return (_v3dot(p3, xdir), _v3dot(p3, ydir))


# ===========================================================================
# main per-sheet builder
# ===========================================================================

def build_sheet(out_stub, sheet_no, sheet_total, drawing_no, name_cn, solid, parts,
                 pins_xy, pin_pairs, boss_notes=None, extra_notes=None, deflection=0.6):
    """
    out_stub: path (no ext) for the .dxf/.pdf, PNG goes to preview/
    solid: cadquery solid (assembly) for HLR
    parts: list of Part (this weldment's laser parts, in pid order)
    pins_xy: dict name -> (x,y) in the assembly's own local frame (z=0 plane)
    pin_pairs: list of (nameA, nameB, label_override or None) for chained dims
    """
    G.log(f"\n--- building sheet {drawing_no} {name_cn} ---")

    front_v, front_h = hlr_view(solid.val().wrapped, "front")
    top_v, top_h = hlr_view(solid.val().wrapped, "top")
    left_v, left_h = hlr_view(solid.val().wrapped, "left")

    fb = polylines_bbox(front_v, front_h)
    tb = polylines_bbox(top_v, top_h)
    lb = polylines_bbox(left_v, left_h)
    fw, fh = fb[2] - fb[0], fb[3] - fb[1]
    tw, th_ = tb[2] - tb[0], tb[3] - tb[1]
    lw, lh = lb[2] - lb[0], lb[3] - lb[1]

    view_gap = 40.0
    views_block_w = max(fw, tw) + view_gap + lw
    views_block_h = fh + view_gap + th_

    # ---- flat parts panel sizing (multi-row shelf pack) ---------------------
    max_part_dim = max((p.bbox[2] - p.bbox[0]) for p in parts)
    parts_row_w = max(max_part_dim + 40.0, 1200.0)
    offsets, parts_total_h = pack_layout(parts, parts_row_w, 120.0)

    need_w = views_block_w + 220.0 + parts_row_w
    need_h = max(views_block_h, parts_total_h) + 260.0  # + title/margins headroom

    scale = SCALES[-1]
    for s in SCALES:
        if need_w <= (FRAME_W_A1 - 40.0) * s and need_h <= (FRAME_H_A1 - 90.0) * s:
            scale = s
            break
    frame_w_model = FRAME_W_A1 * scale
    frame_h_model = FRAME_H_A1 * scale
    overflow = need_w > (FRAME_W_A1 - 40.0) * scale or need_h > (FRAME_H_A1 - 90.0) * scale
    if overflow:
        frame_w_model = max(frame_w_model, need_w + 60.0 * scale)
        frame_h_model = max(frame_h_model, need_h + 120.0 * scale)
        G.log(f"[note] {drawing_no}: content ({need_w:.0f}x{need_h:.0f}) exceeds nominal A1@1:{scale:g}; "
              f"sheet enlarged to {frame_w_model/scale:.0f}x{frame_h_model/scale:.0f} (still labelled 1:{scale:g}).")

    doc = new_sheet_doc()
    msp = doc.modelspace()
    dimstyle = setup_dimstyle(doc, f"PLATE_{drawing_no}", scale)

    # explicit frame border at the (possibly enlarged) size
    msp.add_lwpolyline([(0, 0), (frame_w_model, 0), (frame_w_model, frame_h_model), (0, frame_h_model)],
                        close=True, dxfattribs={"layer": "FRAME"})
    left_m, right_m, top_m, bot_m = 25.0 * scale, 10.0 * scale, 10.0 * scale, 10.0 * scale
    msp.add_lwpolyline([(left_m, bot_m), (frame_w_model - right_m, bot_m),
                         (frame_w_model - right_m, frame_h_model - top_m), (left_m, frame_h_model - top_m)],
                        close=True, dxfattribs={"layer": "FRAME"})

    # ---- place LEFT block: front / top / left views (first-angle) ----------
    origin_x = left_m + 60.0 * scale
    origin_y = frame_h_model - top_m - 60.0 * scale - fh
    fx, fy = origin_x - fb[0], origin_y - fb[1]
    draw_polylines(msp, front_v, fx, fy, "VIEW")
    draw_polylines(msp, front_h, fx, fy, "HIDDEN")

    tx, ty = origin_x - tb[0], origin_y - view_gap - th_ - tb[1]
    draw_polylines(msp, top_v, tx, ty, "VIEW")
    draw_polylines(msp, top_h, tx, ty, "HIDDEN")

    lx, ly = origin_x + fw + view_gap - lb[0], origin_y - lb[1]
    draw_polylines(msp, left_v, lx, ly, "VIEW")
    draw_polylines(msp, left_v, lx, ly, "VIEW")
    draw_polylines(msp, left_h, lx, ly, "HIDDEN")

    txt(msp, "主视图 (前视)", (origin_x, origin_y + fh + 6.0 * scale), 3.2 * scale, layer="NOTE")
    txt(msp, "俯视图", (tx + tb[0], ty + tb[1] - 6.0 * scale - 3.2 * scale), 3.2 * scale, layer="NOTE")
    txt(msp, "左视图", (lx + lb[0], ly + lb[3] + 6.0 * scale), 3.2 * scale, layer="NOTE")

    # ---- pin centre-crosses (front view) + symmetry-plane centrelines ------
    for name, (x, y) in pins_xy.items():
        add_center_cross(msp, (x + fx, y + fy), 10.0 * scale)
        txt(msp, name, (x + fx + 4.0 * scale, y + fy + 4.0 * scale), 2.6 * scale, layer="NOTE")
    msp.add_line((tx + fb[0], ty + project_pt((0, 0, 0), "top")[1]),
                 (tx + fb[0] + fw, ty + project_pt((0, 0, 0), "top")[1]),
                 dxfattribs={"layer": "CENTER"})
    msp.add_line((lx + project_pt((0, 0, 0), "left")[0], ly + lb[1]),
                 (lx + project_pt((0, 0, 0), "left")[0], ly + lb[1] + lh),
                 dxfattribs={"layer": "CENTER"})

    # ---- overall L/H/W dims --------------------------------------------------
    do = 20.0 * scale
    try:
        d = msp.add_aligned_dim(p1=(fx + fb[0], fy + fb[1]), p2=(fx + fb[2], fy + fb[1]), distance=-do,
                                 dimstyle=dimstyle, dxfattribs={"layer": "DIM"})
        d.render()
        d = msp.add_aligned_dim(p1=(fx + fb[0], fy + fb[1]), p2=(fx + fb[0], fy + fb[3]), distance=-do,
                                 dimstyle=dimstyle, dxfattribs={"layer": "DIM"})
        d.render()
        d = msp.add_aligned_dim(p1=(tx + tb[0], ty + tb[1]), p2=(tx + tb[0], ty + tb[3]), distance=-do,
                                 dimstyle=dimstyle, dxfattribs={"layer": "DIM"})
        d.render()
    except Exception as ex:
        G.log(f"[warn] overall dim failed: {ex}")

    # ---- pin-to-pin chained dims ---------------------------------------------
    stack = 0
    for (na, nb, lbl) in pin_pairs:
        if na not in pins_xy or nb not in pins_xy:
            continue
        pa = pins_xy[na]
        pb = pins_xy[nb]
        stack += 1
        try:
            d = msp.add_aligned_dim(p1=(pa[0] + fx, pa[1] + fy), p2=(pb[0] + fx, pb[1] + fy),
                                     distance=do + stack * 9.0 * scale,
                                     dimstyle=dimstyle, dxfattribs={"layer": "DIM"})
            d.render()
        except Exception as ex:
            G.log(f"[warn] pin dim {na}-{nb} failed: {ex}")

    # ---- pin diameter callouts (from hole specs on the side-plate part) ----
    side_part = parts[0]
    for (cx, cy, dia) in side_part.holes:
        try:
            d = msp.add_diameter_dim(center=(cx + fx, cy + fy), radius=dia / 2.0, angle=45,
                                      dimstyle=dimstyle, dxfattribs={"layer": "DIM"})
            d.render()
        except Exception:
            pass

    if boss_notes:
        for i, note in enumerate(boss_notes):
            txt(msp, note, (origin_x, origin_y - th_ - view_gap - 14.0 * scale - i * 6.0 * scale),
                2.6 * scale, layer="NOTE")

    # ---- RIGHT block: flat parts, in pid order -------------------------------
    parts_x0 = origin_x + views_block_w + 100.0 * scale
    parts_y0 = origin_y + fh - parts_total_h
    if parts_y0 < bot_m + 40.0 * scale:
        parts_y0 = bot_m + 40.0 * scale
    txt(msp, "激光切割件展开图 (按代号顺序)", (parts_x0, parts_y0 + parts_total_h + 8.0 * scale), 3.2 * scale,
        layer="NOTE")
    for p in parts:
        dx, dy = offsets[p.pid]
        add_part_geometry(msp, p, parts_x0 + dx, parts_y0 + dy, scale, dimstyle)

    # ---- BOM table + tech requirements, bottom area --------------------------
    bom_x = left_m + 10.0 * scale
    bom_y = bot_m + 65.0 * scale
    tw_bom, th_bom, total_mass = draw_bom_table(msp, parts, (bom_x, bom_y), scale)
    draw_tech_block(msp, (bom_x + tw_bom + 30.0 * scale, bom_y + th_bom - 4.0 * scale), scale,
                     extra_notes=extra_notes)

    draw_title_block(msp, frame_w_model, frame_h_model, scale, drawing_no, name_cn, sheet_no, sheet_total,
                      total_mass)

    auditor = doc.audit()
    assert len(auditor.errors) == 0, f"{drawing_no}: DXF audit errors: {auditor.errors}"
    for e in msp.query("LWPOLYLINE[layer=='CUT']"):
        assert e.closed, f"{drawing_no}: CUT LWPOLYLINE not closed"

    dxf_path = out_stub + ".dxf"
    doc.saveas(dxf_path)
    render_pdf_png(doc, out_stub, frame_w_model, frame_h_model)
    G.log(f"  scale=1:{scale:g}  frame={frame_w_model/scale:.0f}x{frame_h_model/scale:.0f}mm(A1 units)  "
          f"total_mass={total_mass:.1f}kg  -> {dxf_path}")
    return dict(scale=scale, total_mass=total_mass, dxf_path=dxf_path, overflow=overflow)
