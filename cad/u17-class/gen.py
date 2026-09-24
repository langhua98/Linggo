#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
U17-class mini excavator -- arm (斗杆) + boom (动臂) + bucket (铲斗) + linkage
Orchestrator: builds every 2D laser part, the 3D weldments (STEP), runs
kinematics (arm-level + full machine), and writes the 3 GB-style drawing
sheets + BOM.md.

Run: /tmp/claude-0/venv/bin/python cad/u17-class/gen.py
"""

import os
import math

import ezdxf
from ezdxf.enums import TextEntityAlignment
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

import geom as G
import parts as P
import kinematics as K
import model3d as M3
import sheet_specs as SS

HERE = os.path.dirname(os.path.abspath(__file__))
DXFDIR = os.path.join(HERE, "dxf")
PREVDIR = os.path.join(HERE, "preview")
STEPDIR = os.path.join(HERE, "step")
DRAWDIR = os.path.join(HERE, "drawings")
for d in (DXFDIR, PREVDIR, STEPDIR, DRAWDIR):
    os.makedirs(d, exist_ok=True)


# ===========================================================================
# per-part DXF (unchanged rules from spec v1: CUT/MARK layers, audit clean)
# ===========================================================================

def new_part_doc():
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 4
    doc.header["$MEASUREMENT"] = 1
    if "CUT" not in doc.layers:
        doc.layers.add("CUT", color=7)
    if "MARK" not in doc.layers:
        doc.layers.add("MARK", color=3)
    return doc


def add_part_geometry_flat(msp, part, dx=0.0, dy=0.0):
    outer = G.translate_verts(part.outer, dx, dy)
    pl = msp.add_lwpolyline(outer, format="xyb", dxfattribs={"layer": "CUT"})
    pl.closed = True
    for (cx, cy, d) in G.translate_holes(part.holes, dx, dy):
        msp.add_circle((cx, cy), d / 2.0, dxfattribs={"layer": "CUT"})

    mark_pt = part.polygon.representative_point()
    mx, my = mark_pt.x + dx, mark_pt.y + dy
    h = 8.0
    msp.add_text(f"{part.pid} {part.name_cn}", dxfattribs={"layer": "MARK", "height": h, "insert": (mx, my + h)})
    msp.add_text(f"t{part.thickness}  x{part.qty}  {part.material}",
                 dxfattribs={"layer": "MARK", "height": h, "insert": (mx, my - h * 0.4)})
    for (x, y, txt) in part.mark_notes:
        msp.add_text(txt, dxfattribs={"layer": "MARK", "height": 5.0, "insert": (x + dx, y + dy)})
    for (p1, p2) in part.mark_lines:
        msp.add_line((p1[0] + dx, p1[1] + dy), (p2[0] + dx, p2[1] + dy), dxfattribs={"layer": "MARK"})


def write_part_dxf(part):
    doc = new_part_doc()
    msp = doc.modelspace()
    add_part_geometry_flat(msp, part)
    auditor = doc.audit()
    assert len(auditor.errors) == 0, f"{part.pid}: DXF audit errors: {auditor.errors}"
    for e in msp.query("LWPOLYLINE[layer=='CUT']"):
        assert e.closed, f"{part.pid}: CUT LWPOLYLINE not closed"
    path = os.path.join(DXFDIR, part.filename())
    doc.saveas(path)
    return path


# ===========================================================================
# preview PNGs (parts.png, assembly_poses.png, envelope.png)
# ===========================================================================

def draw_part_on_ax(ax, part):
    pts = G.flatten_bulge_ring(part.outer, chord=0.3)
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
    cols = 6
    rows = math.ceil(n / cols)
    fig, axes = plt.subplots(rows, cols, figsize=(cols * 3.4, rows * 3.0))
    axes = axes.flatten()
    for ax, p in zip(axes, all_parts):
        draw_part_on_ax(ax, p)
    for ax in axes[n:]:
        ax.axis("off")
    fig.suptitle("U17-class arm/boom/bucket/linkage laser parts (1:1 profile, not to page scale)", fontsize=11)
    fig.tight_layout(rect=[0, 0, 1, 0.97])
    path = os.path.join(PREVDIR, "parts.png")
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def draw_pose(ax, g, poly_a1, title):
    xs, ys = poly_a1.exterior.xy
    ax.fill(xs, ys, facecolor="#dddddd", edgecolor="#333333", linewidth=1.0, zorder=1)

    bpoly = K.transformed_bucket_polygon(g)
    xs2, ys2 = bpoly.exterior.xy
    ax.fill(xs2, ys2, facecolor="#f7d9a0", edgecolor="#8a4b00", linewidth=1.2, zorder=2)

    Ga = K.G_arm_of(g)
    sol = K.circle_intersection(G.ARM_E, 230.0, Ga, 210.0)
    J = None
    if sol:
        p1, p2 = sol
        J = p1 if p1[1] > p2[1] else p2

    for (pt, name) in [(G.ARM_A, "A"), (G.ARM_B, "B"), (G.ARM_C, "C"), (G.ARM_E, "E"), (G.ARM_D, "D"), (Ga, "G")]:
        ax.plot(*pt, "o", color="black", markersize=3, zorder=4)
        ax.annotate(name, pt, fontsize=7, xytext=(3, 3), textcoords="offset points")
    if J:
        ax.plot(*J, "o", color="red", markersize=4, zorder=5)
        ax.annotate("J", J, fontsize=7, xytext=(3, 3), textcoords="offset points", color="red")
        ax.plot([G.ARM_C[0], J[0]], [G.ARM_C[1], J[1]], "--", color="red", linewidth=1.2, zorder=4)
        L = G.vlen(G.vsub(G.ARM_C, J))
        ax.set_title(f"{title}\ng={g:.0f} deg, L(cyl)={L:.0f}mm", fontsize=9)
    ax.set_aspect("equal")
    ax.tick_params(labelsize=6)


def write_assembly_png(arm_report, poly_a1):
    g_min, g_max = arm_report["g_min"], arm_report["g_max"]
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


def machine_pose_points(theta, phi, g, n=60):
    """Return dict of machine-frame points/polylines for one full-machine pose."""
    O_m = K.MACHINE_O
    A_boom_m = K.boom_to_machine(G.BOOM_A, theta)
    K_m = K.boom_to_machine(G.BOOM_K, theta)
    M_m = K.boom_to_machine(G.BOOM_M, theta)
    N_m = K.boom_to_machine(G.BOOM_N, theta)
    D_m = K.arm_local_to_machine(G.ARM_D, theta, phi)
    B_m = K.arm_local_to_machine(G.ARM_B, theta, phi)
    C_m = K.arm_local_to_machine(G.ARM_C, theta, phi)
    tip_m = K.bucket_local_to_machine(G.BKT_T, theta, phi, g)
    return dict(O=O_m, A=A_boom_m, K=K_m, M=M_m, N=N_m, D=D_m, B=B_m, C=C_m, T=tip_m, P=K.MACHINE_P)


def write_envelope_png(arm_report, machine_report, env_report):
    fig, ax = plt.subplots(figsize=(11, 8))
    # machine outline: simple box on the ground
    box = [(-500, 0), (900, 0), (900, 900), (-500, 900), (-500, 0)]
    xs = [p[0] for p in box]
    ys = [p[1] for p in box]
    ax.fill(xs, ys, facecolor="#cccccc", edgecolor="#555555", zorder=1, label="机体简化外框(示意)")
    ax.axhline(0, color="brown", linewidth=2, zorder=1)

    thetas = machine_report["theta_feasible"] or [t for (t, _) in machine_report["boom_L"]]
    phis = machine_report["phi_feasible"] or [p for (p, _) in machine_report["arm_L"]]
    g_min, g_max = arm_report["g_min"], arm_report["g_max"]
    poses = [
        ("最大挖深姿态", max(thetas, key=lambda t: -1), min(phis), g_min),
        ("中间姿态", (min(thetas) + max(thetas)) / 2.0, (min(phis) + max(phis)) / 2.0, (g_min + g_max) / 2.0),
        ("最大卸载高度姿态", max(thetas), max(phis), g_max),
    ]
    colors = ["#1a4d8f", "#8a4b00", "#0a7d34"]
    for (label, th, ph, g), col in zip(poses, colors):
        pts = machine_pose_points(th, ph, g)
        chain = [pts["O"], pts["A"], pts["D"], pts["T"]]
        xs = [p[0] for p in chain]
        ys = [p[1] for p in chain]
        ax.plot(xs, ys, "-o", color=col, linewidth=2, markersize=4, label=f"{label} (θ={th:.0f}°,φ={ph:.0f}°,g={g:.0f}°)")
        ax.plot(*pts["K"], "s", color=col, markersize=4)
        ax.plot([pts["P"][0], pts["M"][0]], [pts["P"][1], pts["M"][1]], "--", color=col, linewidth=1)
        ax.plot([pts["N"][0], pts["B"][0]], [pts["N"][1], pts["B"][1]], ":", color=col, linewidth=1)

    tip_pts = env_report["tip_points"]
    txs = [p[0] for p in tip_pts]
    tys = [p[1] for p in tip_pts]
    ax.scatter(txs, tys, s=1, color="#999999", alpha=0.25, zorder=0, label="斗尖可达包络(采样)")

    ax.axvline(0, color="k", linewidth=0.7, linestyle=":")
    ax.annotate(f"回转轴 x=0", (0, -150), fontsize=8, ha="center")
    ax.set_aspect("equal")
    ax.set_xlabel("x (mm)")
    ax.set_ylabel("y (mm)")
    ax.set_title(f"U17-class 作业包络: 挖深{env_report['max_dig_depth']:.0f} / 地面处最大伸距"
                 f"{env_report['max_reach_ground']:.0f} / 最大伸距{env_report['max_reach']:.0f} / "
                 f"最大挖掘高度{env_report['max_dig_height']:.0f} / 最大卸载高度{env_report['dump_height']:.0f}"
                 f"  (参考U17: 挖深2300 / 伸距3570)", fontsize=10)
    ax.legend(fontsize=7, loc="upper left")
    ax.grid(True, linestyle=":", linewidth=0.5)
    fig.tight_layout()
    path = os.path.join(PREVDIR, "envelope.png")
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


# ===========================================================================
# BOM.md
# ===========================================================================

def write_bom(all_parts, arm_report, machine_report, env_report, a3check, struck_vol_m3,
              step_reports):
    lines = []
    lines.append("# U17-class 动臂/斗杆/铲斗/连杆总成 — 物料清单 (BOM)\n")
    lines.append("> 尺寸按公开参数推算的自主设计，非久保田原厂图纸；承力件上机前请结构工程师复核；")
    lines.append("> 摆动支架及动臂缸底铰点 P（'on swing bracket'）不在本次设计范围内。\n")

    lines.append("## 激光切割件 (钢板 Q355B，激光切割，刃口件推荐 NM400)\n")
    lines.append("| 编号 | 名称 | 厚度(mm) | 数量 | 材料 | 单件重量(kg) | 备注 |")
    lines.append("|---|---|---|---|---|---|---|")
    total_mass = 0.0
    group_mass = {}
    for p in all_parts:
        m = p.mass_kg_each()
        total_mass += m * p.qty
        group_mass[p.group] = group_mass.get(p.group, 0.0) + m * p.qty
        lines.append(f"| {p.pid} | {p.name_cn} | {p.thickness} | {p.qty} | {p.material} | {m:.2f} | {p.bom_note} |")
    lines.append(f"\n**激光件总重量（含全部数量）≈ {total_mass:.1f} kg**，其中：")
    for grp, gm in group_mass.items():
        lines.append(f"- {grp}: {gm:.1f} kg")
    lines.append("")

    lines.append("## 外购/车加工件\n")
    lines.append("| 名称 | 规格 | 数量 | 备注 |")
    lines.append("|---|---|---|---|")
    lines.append("| 臂A处衬套 | 45#无缝管 OD60 L95，焊后镗至Ø35H8 | 1 | 与A1线镗一起加工 |")
    lines.append("| 臂D/E处衬套 | 45#无缝管 OD50 L95，焊后镗至Ø30H8 | 2 | D、E各一 |")
    lines.append("| 斗D/G处耳衬套 | 45#无缝管 OD50 L25，焊后镗至Ø30H8 | 4 | 内平齐、外凸出13 |")
    lines.append("| 动臂脚部衬套 | 45#无缝管 OD70 ID40 L117，焊后镗至Ø40H8 | 1 | 与B1线镗一起加工 |")
    lines.append("| 销轴 Ø30 | 40Cr 调质 | D,E,G,J,C 共5根 | 长度按各处叠层估算 |")
    lines.append("| 销轴 Ø35 | 40Cr 调质 | 臂杆A、动臂A/M/N 共4根 | 长度按叠层估算 |")
    lines.append("| 销轴 Ø40 | 40Cr 调质 | 动臂脚O 1根 | 长度按叠层估算，摆动支架侧未设计 |")
    lines.append("| G处衬套 | 无缝管 OD45 ID30.5 L75 | 1 | 斗连杆之间隔套 |")
    lines.append(f"| 斗缸 | 缸径55/杆径30，闭合长560，行程300（伸出860），铰点Ø30 | 1 | 外购液压缸；"
                 f"**注**: v1初稿曾写行程320，spec v2 §2已改为300，本版按300实现 |")
    lines.append(f"| 臂缸 | 闭合长{K.ARM_CYL_CLOSED:.0f}，行程{K.ARM_CYL_STROKE:.0f}"
                 f"（伸出{K.ARM_CYL_CLOSED+K.ARM_CYL_STROKE:.0f}），N-B铰接，铰点Ø35 | 1 | 外购液压缸 |")
    lines.append(f"| 动臂缸 | 闭合长{K.BOOM_CYL_CLOSED:.0f}，行程{K.BOOM_CYL_STROKE:.0f}"
                 f"（伸出{K.BOOM_CYL_CLOSED+K.BOOM_CYL_STROKE:.0f}），P-M铰接，铰点Ø35 | 1 | "
                 f"外购液压缸；P点在摆动支架上，本设计未涉及 |\n")

    lines.append("## 装配接口尺寸\n")
    lines.append("| 项目 | 数值(mm) |")
    lines.append("|---|---|")
    lines.append("| 臂杆销孔：A/D/E/B | Ø35(A) / Ø30(D,E,B) |")
    lines.append("| 动臂销孔：O/A/M/N | Ø40(O) / Ø35(A,M,N) |")
    lines.append("| 斗杆连杆(L1)内间距 | 97（套装于臂杆外侧，臂杆外宽95） |")
    lines.append("| 铲斗耳板(K5)内间距 | 97（臂杆外宽95插入其间） |")
    lines.append("| 斗缸耳板(A5)内间距 | 62 |")
    lines.append("| 动臂缸耳板(B4)内间距 | 72（外104<117） |")
    lines.append("| 臂缸耳板(B5)内间距 | 72 |")
    lines.append("| 铲斗切割宽度（外/内） | 400 / 384，侧板t8 |")
    lines.append("| 动臂箱形梁宽度（内/外） | 97 / 117，侧板t10 |\n")

    lines.append("## 运动学核算\n")
    lines.append("### 斗杆级（斗缸驱动铲斗回转，g=铲斗绕D的极角）\n")
    lines.append(f"- 缸(560~860mm)可达 g 范围：**{arm_report['g_min']:.0f}° 至 {arm_report['g_max']:.0f}°**"
                 f"（跨度 {arm_report['span']:.0f}°）；对应斗尖角(g-90)：**{arm_report['tip_min']:.1f}° 至 "
                 f"{arm_report['tip_max']:.1f}°**")
    lines.append(f"- 最小传动角 **{arm_report['min_transmission_angle']:.1f}°** (g="
                 f"{arm_report['min_transmission_angle_g']:.0f}°，合格区间[35°,145°]内)；"
                 f"斗缸对D点最小力臂 **{arm_report['min_bucket_moment_arm']:.1f} mm**")
    cl = arm_report['min_cyl_arm_clearance']
    lines.append(f"- 斗缸胶囊体与斗杆侧板最小间隙：**{cl:.1f} mm**" if cl >= 0 else
                 f"- 斗缸胶囊体与斗杆侧板存在干涉（量级 {-cl:.1f} mm）")
    lines.append(f"- 铲斗与斗杆(扣除D处R55轮毂圆)：最大重叠 **{arm_report['max_bucket_arm_overlap']:.1f} mm²**，"
                 f"最小间隙 **{arm_report['min_bucket_arm_clearance']:.1f} mm**")
    lines.append(f"- **收斗极限判据**：g={arm_report['g_min']:.0f}° 处斗体-斗杆间隙={arm_report['curl_limit_clearance_at_gmin']:.1f}mm，"
                 f"governing factor = **{arm_report['curl_limit_governs']}**\n")

    lines.append("### 机架级（动臂θ + 斗杆φ + 铲斗g 全链运动学，见 preview/envelope.png）\n")
    for l in machine_report["lines"]:
        lines.append(f"- {l}")
    lines.append(f"- A3窗口核查：可行phi范围内共抽检{a3check['n_checked']}个姿态，臂缸杆线与A3顶板footprint相交"
                 f"**{a3check['hits']}** 次，最小间隙 **{a3check['min_clear']:.1f} mm** "
                 f"（{'窗口足够，未见干涉' if a3check['hits']==0 else '窗口不足，存在干涉，需加大窗口或改B点位置'}）\n")

    lines.append("### 整机包络 (preview/envelope.png)\n")
    lines.append("| 指标 | 本设计 | U17参考 |")
    lines.append("|---|---|---|")
    lines.append(f"| 最大挖掘深度 | {env_report['max_dig_depth']:.0f} mm | {K.REF_U17_DEPTH:.0f} mm |")
    lines.append(f"| 地面处最大伸距(\\|tip.y\\|<15) | {env_report['max_reach_ground']:.0f} mm | {K.REF_U17_REACH:.0f} mm(参考:最大伸距) |")
    lines.append(f"| 最大伸距(任意高度) | {env_report['max_reach']:.0f} mm | - |")
    lines.append(f"| 最大挖掘高度(斗尖) | {env_report['max_dig_height']:.0f} mm | - |")
    lines.append(f"| 最大卸载高度(斗销D高度-450，近似) | {env_report['dump_height']:.0f} mm "
                 f"(D最高点{env_report['max_D_height']:.0f}mm) | - |")
    lines.append(f"\n铲斗结构容量（型线面积x宽度384）≈ {struck_vol_m3:.4f} m^3。\n")

    lines.append("## 3D实体校核 (CadQuery, step/*.step)\n")
    lines.append("| 部件 | 实体有效 | 3D体积质量(kg) | 2D件汇总质量(kg,含对应外购衬套/环) | 偏差 |")
    lines.append("|---|---|---|---|---|")
    for name, r in step_reports.items():
        lines.append(f"| {name} | {r['valid']} | {r['mass_3d_kg']:.2f} | {r['mass_2d_sum_kg']:.2f} | {r['diff_pct']:+.1f}% |")
    lines.append("")

    lines.append("## 组焊工艺要点\n")
    lines.append("1. **斗杆总成**：A1侧板×2先与A2底板、A3顶板、A4后板点固定位组焊成箱形梁；"
                  "D->B切线段上 x<-120(臂系) 保持敞开，为臂缸杆头进出让位。A5斗缸耳板焊于顶板附近，A6环贴焊于B孔外侧。")
    lines.append("2. **动臂总成**：B1侧板×2先与B2顶板(单件折弯)、B3底板(单件折弯)点固定位组焊成箱形梁；"
                  "B4/B5耳板分别焊于腹部/顶部；B6端环贴焊于A孔外侧。脚部Ø70衬套与A孔一起焊后镗孔。")
    lines.append("3. **焊后镗孔**：斗杆A(Ø35H8)/D/E(Ø30H8)/B(Ø30H9)、动臂O(Ø40H8)/A(Ø35H9) 均先焊后镗，保证两侧板同轴。")
    lines.append("4. **折弯件**：动臂B2/B3、铲斗K4为单件折弯/卷弧成型，须先下料再折弯/卷弧，MARK层已标出折弯/卷弧基准线与角度。")
    lines.append(f"5. **理论容量**：铲斗结构容量 ≈ {struck_vol_m3:.4f} m³（参考，未计边坡角修正）。\n")

    lines.append("## 已知偏差 / 需人工确认事项\n")
    lines.append("- 动臂缸(P-M)胶囊体半径 spec 未给出，本设计沿用臂缸同款假设 (R40/前700mm, R18/余下)，仅供参考。")
    lines.append("- 3D装配中 B2/B3(动臂)、K4(铲斗)按**实际弯曲后形状**沿中性弧建模(宽度居中于路径两侧)，"
                 "与 2D 展开图(平板下料图)分属两种表示，互不矛盾。")
    lines.append("- 斗缸行程由 v1 的 320 改为 v2 §2 明确写的 300（560~860mm窗口不变），已按 v2 实现并在此说明。\n")

    lines.append("## 明细文件\n")
    lines.append("- `drawings/01_bucket.pdf`、`02_arm.pdf`、`03_boom.pdf`：三张焊接件图纸（左侧三视图 + 右侧按代号排版的钣金展开料，含全部尺寸、坐标表、明细栏），同名 .dxf 为可编辑版")
    lines.append("- `dxf/*.dxf`：各零件1:1激光切割图")
    lines.append("- `step/*.step`：三个总成的3D实体模型")
    lines.append("- `drawings/0{1,2,3}_*.dxf/.pdf`：三张GB格式装配图纸（三视图+展开件+明细栏+技术要求）")
    lines.append("- `preview/parts.png`：全零件预览图")
    lines.append("- `preview/assembly_poses.png`：斗杆级三姿态装配预览图")
    lines.append("- `preview/envelope.png`：整机作业包络图\n")

    path = os.path.join(HERE, "BOM.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path, total_mass


# ===========================================================================
# MAIN
# ===========================================================================

def main():
    G.log("=" * 78)
    G.log("U17-class boom/arm/bucket/linkage generator (spec v2)")
    G.log("=" * 78)

    arm_parts, arm_kin = P.build_arm_parts()
    link_parts = P.build_linkage_parts()
    bucket_parts, bucket_info = P.build_bucket_parts()
    boom_parts, boom_kin = P.build_boom_parts()
    all_parts = boom_parts + arm_parts + link_parts + bucket_parts

    G.log("\n--- writing per-part DXF ---")
    for p in all_parts:
        path = write_part_dxf(p)
        G.log(f"  {p.pid}: {os.path.relpath(path, HERE)}  area={p.area_mm2():.0f}mm^2  "
              f"mass/ea={p.mass_kg_each():.3f}kg  qty={p.qty}")

    G.log("\n--- writing preview/parts.png ---")
    png1 = write_parts_png(all_parts)
    G.log(f"  {os.path.relpath(png1, HERE)}")

    G.log("\n--- arm-level kinematics ---")
    arm_report = K.arm_level_kinematics(arm_kin["poly_a1"])
    G.log(f"  cylinder-reachable g range: {arm_report['g_min']:.0f} .. {arm_report['g_max']:.0f} deg")
    G.log(f"  min transmission angle: {arm_report['min_transmission_angle']:.1f} deg")
    G.log(f"  curl-limit governs: {arm_report['curl_limit_governs']}")

    G.log("\n--- writing preview/assembly_poses.png ---")
    png2 = write_assembly_png(arm_report, arm_kin["poly_a1"])
    G.log(f"  {os.path.relpath(png2, HERE)}")

    G.log("\n--- machine-level kinematics ---")
    machine_report = K.machine_kinematics(arm_kin["poly_a1"], boom_kin["poly_b1"], arm_report)
    for l in machine_report["lines"]:
        G.log(f"  {l}")

    a3check = K.check_a3_window(arm_kin, machine_report["phi_feasible"])
    G.log(f"  A3 window check: {a3check['hits']}/{a3check['n_checked']} interferences, "
          f"min clearance {a3check['min_clear']:.1f} mm")
    assert a3check["hits"] == 0, "A3 window insufficient: arm-cylinder rod line crosses the A3 top plate"

    G.log("\n--- envelope ---")
    env_report = K.compute_envelope(arm_report, machine_report)
    G.log(f"  max dig depth: {env_report['max_dig_depth']:.0f} mm (ref U17: {K.REF_U17_DEPTH:.0f})")
    G.log(f"  max reach @ground: {env_report['max_reach_ground']:.0f} mm (ref U17 reach: {K.REF_U17_REACH:.0f})")
    G.log(f"  max reach (any height): {env_report['max_reach']:.0f} mm")
    G.log(f"  max dig height: {env_report['max_dig_height']:.0f} mm")
    G.log(f"  max dump height: {env_report['dump_height']:.0f} mm (D max height {env_report['max_D_height']:.0f})")

    G.log("\n--- writing preview/envelope.png ---")
    png3 = write_envelope_png(arm_report, machine_report, env_report)
    G.log(f"  {os.path.relpath(png3, HERE)}")

    # ---- 3D weldments -----------------------------------------------------
    G.log("\n--- 3D weldments (CadQuery -> STEP) ---")
    bkt_by_id = {p.pid: p for p in bucket_parts}
    arm_by_id = {p.pid: p for p in arm_parts}
    boom_by_id = {p.pid: p for p in boom_parts}

    bkt_solid = M3.build_bucket_solid(bkt_by_id, bucket_info["poly_k1"])
    arm_solid = M3.build_arm_solid(arm_by_id, arm_kin)
    boom_solid = M3.build_boom_solid(boom_by_id, boom_kin)

    for s in (bkt_solid, arm_solid, boom_solid):
        assert s.val().isValid(), "3D solid invalid"

    step_reports = {}
    step_reports["bucket"] = M3.export_step_and_check(
        bkt_solid, os.path.join(STEPDIR, "bucket.step"), bucket_parts, "bucket")
    step_reports["arm"] = M3.export_step_and_check(
        arm_solid, os.path.join(STEPDIR, "arm.step"), arm_parts, "arm")
    step_reports["boom"] = M3.export_step_and_check(
        boom_solid, os.path.join(STEPDIR, "boom.step"), boom_parts, "boom")

    # ---- drawing sheets -----------------------------------------------------
    G.log("\n--- drawing sheets ---")

    r1 = SS.bucket_sheet(os.path.join(DRAWDIR, "01_bucket"), bkt_solid, bucket_parts, 3)
    r2 = SS.arm_sheet(os.path.join(DRAWDIR, "02_arm"), arm_solid, arm_parts, link_parts, arm_kin, 3)
    r3 = SS.boom_sheet(os.path.join(DRAWDIR, "03_boom"), boom_solid, boom_parts, boom_kin, 3)
    for r, name in ((r1, "01_bucket"), (r2, "02_arm"), (r3, "03_boom")):
        G.log(f"  {name}: {r['paper']} 1:{r['scale']:g}")

    # ---- BOM.md ---------------------------------------------------------------
    G.log("\n--- writing BOM.md ---")
    bom_path, total_mass = write_bom(all_parts, arm_report, machine_report, env_report, a3check,
                                      bucket_info["struck_vol_m3"], step_reports)
    G.log(f"  {os.path.relpath(bom_path, HERE)}  total laser-part mass = {total_mass:.1f} kg")

    G.log("\nAll done, no assertion failures.")


if __name__ == "__main__":
    main()
