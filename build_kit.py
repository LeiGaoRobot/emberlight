"""Headless Blender script: build the Emberlight asset kit and export one GLB.

Run:  D:/AI/tools/Blender/blender.exe -b -P build_kit.py -- --out D:/AI/emberlight
Outputs: site/assets/kit.glb + preview.png (kit lineup render)

Contract with the web side (site/world.js):
  * every kit item is an Empty named Kit_<Name>; its children are built in local
    coordinates (Z up, front = -Y).  The page detaches the Empty, zeroes its
    position and uses it as a template for instancing.
  * child objects whose name starts with Snow_ are winter-only.
  * emissive materials (WindowGlass, Fire, Lantern, EnemyEye, EmberCore, HotMetal,
    Crystal, ShardCrystal, PlayerLamp) are baked into separate "glow" instanced
    meshes so the page can drive their intensity (day/night, hit flash).
  * rigs (Kit_Player, Kit_Warden) keep named parts: P_Body, P_Head, P_ArmL, P_ArmR,
    P_Lantern, P_Blade, W_Body, W_Head, W_Blade, W_ArmL, W_ArmR.
"""
import bpy, bmesh, math, random, sys, os
from mathutils import Vector

random.seed(11)
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(OUT, "site", "assets"), exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
COL = bpy.context.collection

# ---------------------------------------------------------------- materials
MATS = {}
def srgb(hexstr):
    h = hexstr.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    lin = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin(r), lin(g), lin(b))

def mat(name, hexcol, rough=0.85, emit=None, strength=0.0, metal=0.0):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*srgb(hexcol), 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emit is not None:
        bsdf.inputs["Emission Color"].default_value = (*srgb(emit), 1.0)
        bsdf.inputs["Emission Strength"].default_value = strength
    m.diffuse_color = (*srgb(hexcol), 1.0)
    MATS[name] = m
    return m

M = dict(
    Wall=mat("Wall", "#efe1c8"), WallDark=mat("WallDark", "#d9c6a6"), Timber=mat("Timber", "#5e4230"),
    Roof=mat("Roof", "#8c6f9e"), RoofLight=mat("RoofLight", "#a58ab4"), RoofDark=mat("RoofDark", "#6c5480"),
    RoofBlue=mat("RoofBlue", "#5f7f9c"), RoofBlueDark=mat("RoofBlueDark", "#46627c"),
    Stone=mat("Stone", "#a29d9a"), StoneDark=mat("StoneDark", "#6b6668"), Cobble=mat("Cobble", "#8f8783"),
    Door=mat("Door", "#b8783f"), Frame=mat("Frame", "#3f2c1f"), WoodLight=mat("WoodLight", "#c8a06a"),
    WindowGlass=mat("WindowGlass", "#ffd9a0", rough=0.3, emit="#ffc470", strength=3.0),
    Trunk=mat("Trunk", "#5f4331"), Leaves=mat("Leaves", "#4f9a55"), LeavesDark=mat("LeavesDark", "#3a7a45"),
    Pine=mat("Pine", "#2f6b46"), Bush=mat("Bush", "#4c8f4b"), Grass=mat("Grass", "#6aa552"),
    Moss=mat("Moss", "#6fa06a"), DeadWood=mat("DeadWood", "#4a3e3a"), Ash=mat("Ash", "#241f28"),
    AshLight=mat("AshLight", "#3a3240"), Fire=mat("Fire", "#ff8a3d", rough=0.4, emit="#ff6a1a", strength=6.0),
    Lantern=mat("Lantern", "#ffe6a8", rough=0.3, emit="#ffd070", strength=5.0),
    Iron=mat("Iron", "#3a3d46", rough=0.5, metal=0.2), Snow=mat("Snow", "#f4f7ff", rough=0.95),
    Water=mat("Water", "#6fb7e8", rough=0.1), Rope=mat("Rope", "#b59a6a"), Hay=mat("Hay", "#d8b35a"),
    Mushroom=mat("Mushroom", "#d9483b"), MushroomStem=mat("MushroomStem", "#efe3c8"),
    Reed=mat("Reed", "#8fae5a"), HotMetal=mat("HotMetal", "#ffb24a", rough=0.4, emit="#ff7a1a", strength=4.0),
    EnemyEye=mat("EnemyEye", "#ffb347", rough=0.3, emit="#ff9a2e", strength=8.0),
    EmberCore=mat("EmberCore", "#ff7a3d", rough=0.3, emit="#ff6a2a", strength=6.0),
    Crystal=mat("Crystal", "#7ff0dc", rough=0.2, emit="#5fe0c8", strength=3.0),
    ShardCrystal=mat("ShardCrystal", "#ffb45a", rough=0.2, emit="#ff9a3a", strength=3.0),
    PlayerLamp=mat("PlayerLamp", "#fff0c0", rough=0.3, emit="#ffd58a", strength=6.0),
    Cloak=mat("Cloak", "#2f6f73"), CloakDark=mat("CloakDark", "#224f55"), Skin=mat("Skin", "#f2c9a4"),
    Hair=mat("Hair", "#4a2f24"), Belt=mat("Belt", "#7a5230"), Boot=mat("Boot", "#3b2a22"),
    Horn=mat("Horn", "#8a7a70"), Bone=mat("Bone", "#d9d0c0"), Warden=mat("Warden", "#1b1720"),
    WardenTrim=mat("WardenTrim", "#5a3a2e"), Flag=mat("Flag", "#c95a4a"),
)

# ---------------------------------------------------------------- helpers
def link(o):
    COL.objects.link(o)
    return o

def _finish(o, name, material, bevel=0.0, parent=None, smooth=False):
    o.name = name
    if material is not None:
        o.data.materials.clear()
        o.data.materials.append(material)
    if bevel > 0:
        b = o.modifiers.new("Bevel", "BEVEL")
        b.width = bevel
        b.segments = 2
        b.limit_method = "ANGLE"
    for p in o.data.polygons:
        p.use_smooth = smooth
    if parent is not None:
        o.parent = parent
    return o

def empty(name, loc=(0, 0, 0)):
    e = bpy.data.objects.new(name, None)
    link(e)
    e.location = loc
    e.empty_display_size = 0.3
    return e

def box(name, loc, size, material, parent, rot=(0, 0, 0), bevel=0.02):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.scale = size
    return _finish(o, name, material, bevel, parent)

def cyl(name, loc, r, h, material, parent, rot=(0, 0, 0), verts=12, r2=None, smooth=False):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=loc, rotation=rot)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=h, location=loc, rotation=rot)
    return _finish(bpy.context.object, name, material, 0, parent, smooth)

def cone(name, loc, r1, h, material, parent, rot=(0, 0, 0), verts=10, r2=0.0):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r1, radius2=r2, depth=h, location=loc, rotation=rot)
    return _finish(bpy.context.object, name, material, 0, parent)

def ball(name, loc, r, material, parent, scale=(1, 1, 1), sub=2, rot=(0, 0, 0), smooth=False):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=sub, radius=r, location=loc, rotation=rot)
    o = bpy.context.object
    o.scale = scale
    return _finish(o, name, material, 0, parent, smooth)

def wedge(name, loc, w, d, h, material, parent, rot_z=0.0):
    """Gable roof prism, ridge along X."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    x, y = w / 2, d / 2
    v = [bm.verts.new(p) for p in [(-x, -y, 0), (x, -y, 0), (x, y, 0), (-x, y, 0), (-x, 0, h), (x, 0, h)]]
    for f in [(0, 1, 5, 4), (2, 3, 4, 5), (1, 2, 5), (3, 0, 4), (3, 2, 1, 0)]:
        bm.faces.new([v[i] for i in f])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    o = link(bpy.data.objects.new(name, me))
    o.location = loc
    o.rotation_euler = (0, 0, rot_z)
    return _finish(o, name, material, 0, parent)

def lean_to(name, loc, w, d, h_low, h_high, material, parent):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    x, y = w / 2, d / 2
    t = 0.12
    pts = [(-x, -y, h_low), (x, -y, h_high), (x, y, h_high), (-x, y, h_low)]
    top = [bm.verts.new(p) for p in pts]
    bot = [bm.verts.new((p[0], p[1], p[2] - t)) for p in pts]
    bm.faces.new(top); bm.faces.new(list(reversed(bot)))
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new([bot[i], bot[j], top[j], top[i]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    o = link(bpy.data.objects.new(name, me))
    o.location = loc
    return _finish(o, name, material, 0, parent)

def arc(name, loc, r_in, r_out, a0, a1, t, material, parent, segs=14, rot=(0, 0, 0)):
    """Ring sector in the XY plane, thickness t along Z (used for crescent blades)."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    top, bot = [], []
    for i in range(segs + 1):
        a = a0 + (a1 - a0) * i / segs
        k = math.sin(math.pi * i / segs)
        ro = r_in + (r_out - r_in) * (0.25 + 0.75 * k)
        for lst, z in ((top, t / 2), (bot, -t / 2)):
            lst.append((bm.verts.new((math.cos(a) * r_in, math.sin(a) * r_in, z)),
                        bm.verts.new((math.cos(a) * ro, math.sin(a) * ro, z))))
    for i in range(segs):
        bm.faces.new([top[i][0], top[i][1], top[i + 1][1], top[i + 1][0]])
        bm.faces.new([bot[i + 1][0], bot[i + 1][1], bot[i][1], bot[i][0]])
        bm.faces.new([top[i][1], bot[i][1], bot[i + 1][1], top[i + 1][1]])
        bm.faces.new([top[i + 1][0], bot[i + 1][0], bot[i][0], top[i][0]])
    bm.faces.new([top[0][0], bot[0][0], bot[0][1], top[0][1]])
    bm.faces.new([top[-1][1], bot[-1][1], bot[-1][0], top[-1][0]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    o = link(bpy.data.objects.new(name, me))
    o.location = loc
    o.rotation_euler = rot
    return _finish(o, name, material, 0, parent)

# kit registry: items laid out on a grid for the preview render
KIT = []
def kit(name):
    i = len(KIT)
    e = empty(f"Kit_{name}", ((i % 8) * 7.0, (i // 8) * 8.0, 0))
    KIT.append(e)
    return e

# ---------------------------------------------------------------- shared building bits
def gable_house(P, W, D, H, roof=("Roof", "RoofLight", "RoofDark"), ridge_x=True, tiles=True, cx=0.0, cy=0.0, wall=None):
    wall = wall or M["Wall"]
    box("Walls", (cx, cy, H / 2), (W, D, H), wall, P)
    box("Base", (cx, cy, 0.16), (W + 0.14, D + 0.14, 0.32), M["Stone"], P)
    for sx in (-1, 1):
        box(f"Beam{sx}", (cx + sx * (W / 2 - 0.05), cy, H / 2), (0.1, D + 0.04, 0.14), M["Timber"], P, bevel=0.0)
        box(f"BeamY{sx}", (cx, cy + sx * (D / 2 - 0.05), H / 2), (W + 0.04, 0.1, 0.14), M["Timber"], P, bevel=0.0)
    for sx in (-1, 1):
        for sy in (-1, 1):
            box(f"Post{sx}{sy}", (cx + sx * (W / 2), cy + sy * (D / 2), H / 2), (0.14, 0.14, H), M["Timber"], P, bevel=0.0)
    RW, RD, RH = W + 0.7, D + 0.8, min(W, D) * 0.6
    if not ridge_x:
        RW, RD = RD, RW
    wedge("Roof", (cx, cy, H - 0.05), RW, RD, RH, M[roof[0]], P, rot_z=0 if ridge_x else math.pi / 2)
    ridge_size = (RW + 0.1, 0.22, 0.14) if ridge_x else (0.22, RW + 0.1, 0.14)
    box("Ridge", (cx, cy, H - 0.05 + RH + 0.02), ridge_size, M[roof[2]], P)
    eave = (RW, RD, 0.1) if ridge_x else (RD, RW, 0.1)
    box("Eave", (cx, cy, H - 0.08), eave, M[roof[2]], P, bevel=0.0)
    if tiles:
        slope = math.atan2(RH, RD / 2)
        pitch_len = math.hypot(RD / 2, RH)
        ROWS, TW = 4, 0.42
        tile_mats = [M[roof[0]], M[roof[1]], M[roof[2]]]
        for side in (-1, 1):
            n = Vector((0, side * RH, RD / 2)).normalized()
            for k in range(ROWS):
                f = (k + 0.5) / ROWS
                yy = side * (RD / 2) * (1 - f)
                zz = H - 0.05 + RH * f
                stag = (TW / 2) if k % 2 else 0.0
                count = int(RW / TW) + 2
                for t in range(count):
                    xx = -RW / 2 + stag + t * TW
                    if xx < -RW / 2 - 0.05 or xx > RW / 2 + 0.05:
                        continue
                    lx, ly, lz = xx, yy + n.y * 0.05, zz + n.z * 0.05
                    rot = (side * -slope, 0, 0)
                    size = (TW - 0.03, pitch_len / ROWS + 0.06, 0.07)
                    if not ridge_x:
                        lx, ly = -ly, lx
                        rot = (0, side * slope, math.pi / 2)
                    box(f"Tile{side}{k}{t}", (cx + lx, cy + ly, lz), size, tile_mats[(k + t) % 3], P, rot=rot, bevel=0.0)
    slope = math.atan2(RH, RD / 2)
    pitch_len = math.hypot(RD / 2, RH)
    for side in (-1, 1):
        n = Vector((0, side * RH, RD / 2)).normalized()
        yy = side * RD / 4
        zz = H - 0.05 + RH / 2
        lx, ly, lz = 0, yy + n.y * 0.12, zz + n.z * 0.12
        size = (RW + 0.05, pitch_len * 0.98, 0.12)
        rot = (side * -slope, 0, 0)
        if not ridge_x:
            lx, ly = -ly, lx
            rot = (0, side * slope, math.pi / 2)
        box(f"Snow_Roof{side}", (cx + lx, cy + ly, lz), size, M["Snow"], P, rot=rot, bevel=0.03)
    return RW, RD, RH

def door(P, x, y, z=0, rot_z=0.0, glow=False):
    g = empty("DoorGrp")
    g.parent = P
    g.location = (x, y, z)
    g.rotation_euler = (0, 0, rot_z)
    box("DoorFrame", (0, -0.03, 0.55), (0.9, 0.1, 1.1), M["Frame"], g, bevel=0.0)
    cyl("DoorArchF", (0, -0.03, 1.1), 0.45, 0.1, M["Frame"], g, rot=(math.pi / 2, 0, 0), verts=16)
    box("Door", (0, -0.07, 0.5), (0.74, 0.08, 1.0), M["Door"], g, bevel=0.0)
    cyl("DoorArch", (0, -0.07, 1.0), 0.37, 0.08, M["Door"], g, rot=(math.pi / 2, 0, 0), verts=16)
    ball("Knob", (0.22, -0.12, 0.95), 0.05, M["Iron"], g, sub=1)
    box("Step", (0, -0.25, 0.06), (1.0, 0.36, 0.12), M["Stone"], g, bevel=0.02)
    if glow:
        box("Lamp", (0.62, -0.1, 1.55), (0.16, 0.16, 0.22), M["Lantern"], g, bevel=0.0)
        box("LampCage", (0.62, -0.1, 1.55), (0.2, 0.2, 0.06), M["Iron"], g, bevel=0.0)

def window(P, x, y, z, rot_z=0.0, w=0.62, h=0.62, sill=True):
    g = empty("WinGrp")
    g.parent = P
    g.location = (x, y, z)
    g.rotation_euler = (0, 0, rot_z)
    box("WinFrame", (0, 0, 0), (w + 0.12, 0.1, h + 0.12), M["Frame"], g, bevel=0.0)
    box("WinGlass", (0, -0.03, 0), (w, 0.06, h), M["WindowGlass"], g, bevel=0.0)
    box("MullV", (0, -0.06, 0), (0.05, 0.02, h), M["Frame"], g, bevel=0.0)
    box("MullH", (0, -0.06, 0), (w, 0.02, 0.05), M["Frame"], g, bevel=0.0)
    if sill:
        box("Sill", (0, -0.1, -h / 2 - 0.05), (w + 0.2, 0.2, 0.1), M["Timber"], g, bevel=0.01)
        for sx in (-1, 1):
            box(f"Shutter{sx}", (sx * (w / 2 + 0.2), -0.04, 0), (0.24, 0.05, h + 0.04), M["Timber"], g, bevel=0.0)

def chimney(P, x, y, z):
    box("Chimney", (x, y, z + 0.6), (0.5, 0.5, 1.3), M["StoneDark"], P)
    box("ChimneyCap", (x, y, z + 1.3), (0.64, 0.64, 0.12), M["Stone"], P)

# ---------------------------------------------------------------- 1. House_A: cottage
P = kit("House_A")
W, D, H = 3.2, 2.5, 2.1
gable_house(P, W, D, H)
door(P, -0.8, -D / 2 - 0.02, glow=True)
window(P, 0.7, -D / 2 - 0.03, 1.3)
window(P, W / 2 + 0.03, 0.2, 1.3, rot_z=-math.pi / 2)
window(P, -W / 2 - 0.03, 0.2, 1.3, rot_z=math.pi / 2)
chimney(P, 0.9, 0.4, H + 0.6)
box("Planter", (0.7, -D / 2 - 0.22, 0.14), (0.9, 0.3, 0.28), M["Timber"], P)
for i in range(4):
    ball(f"Flower{i}", (0.42 + i * 0.18, -D / 2 - 0.22, 0.34), 0.07, M["Mushroom"] if i % 2 else M["Hay"], P, sub=1)

# ---------------------------------------------------------------- 2. House_B: two-storey with blue roof
P = kit("House_B")
W, D, H = 2.8, 2.8, 3.1
box("Lower", (0, 0, 0.7), (W + 0.2, D + 0.2, 1.4), M["Stone"], P)
gable_house(P, W, D, H, roof=("RoofBlue", "RoofBlue", "RoofBlueDark"), ridge_x=False, wall=M["WallDark"])
door(P, 0, -D / 2 - 0.12, glow=True)
window(P, -0.8, -D / 2 - 0.03, 2.2)
window(P, 0.8, -D / 2 - 0.03, 2.2)
window(P, W / 2 + 0.03, 0, 2.2, rot_z=-math.pi / 2)
window(P, -W / 2 - 0.03, 0, 2.2, rot_z=math.pi / 2)
box("Balcony", (0, -D / 2 - 0.35, 1.5), (1.8, 0.7, 0.1), M["Timber"], P)
for i in range(5):
    box(f"Rail{i}", (-0.8 + i * 0.4, -D / 2 - 0.66, 1.75), (0.06, 0.06, 0.5), M["Timber"], P, bevel=0.0)
box("RailTop", (0, -D / 2 - 0.66, 2.0), (1.7, 0.06, 0.06), M["Timber"], P, bevel=0.0)
chimney(P, -0.8, 0.6, H + 0.9)

# ---------------------------------------------------------------- 3. House_C: barn / storehouse
P = kit("House_C")
W, D, H = 4.2, 2.4, 2.0
gable_house(P, W, D, H, roof=("RoofDark", "Roof", "RoofDark"), tiles=False, wall=M["Timber"])
for i in range(9):
    box(f"Plank{i}", (-W / 2 + 0.25 + i * 0.47, -D / 2 - 0.02, H / 2), (0.4, 0.05, H - 0.1), M["WoodLight"] if i % 2 else M["Timber"], P, bevel=0.0)
box("BigDoor", (0.9, -D / 2 - 0.06, 0.8), (1.3, 0.08, 1.6), M["Door"], P, bevel=0.0)
box("BigDoorX1", (0.9, -D / 2 - 0.11, 0.8), (1.25, 0.04, 0.12), M["Frame"], P, rot=(0, 0.9, 0), bevel=0.0)
box("BigDoorX2", (0.9, -D / 2 - 0.11, 0.8), (1.25, 0.04, 0.12), M["Frame"], P, rot=(0, -0.9, 0), bevel=0.0)
window(P, -1.2, -D / 2 - 0.03, 1.3, sill=False)
lean_to("Shed", (-W / 2 - 0.7, 0.1, 0), 1.5, 2.2, 1.2, 1.7, M["RoofDark"], P)
for py in (-0.9, 0.9):
    cyl(f"ShedPost{py}", (-W / 2 - 1.35, py, 0.6), 0.06, 1.2, M["Timber"], P, verts=8)
for k in range(2):
    for j in range(3 - k):
        cyl(f"Log{k}{j}", (-W / 2 - 0.7, -0.7 + j * 0.3 + k * 0.15, 0.13 + k * 0.24), 0.13, 1.0, M["Trunk"], P, rot=(0, math.pi / 2, 0), verts=8)
ball("HayA", (-W / 2 - 0.7, 0.6, 0.35), 0.4, M["Hay"], P, scale=(1, 1, 0.8), sub=1)

# ---------------------------------------------------------------- 4. Tower
P = kit("Tower")
cyl("TowerBody", (0, 0, 2.2), 1.15, 4.4, M["Stone"], P, verts=16)
cyl("TowerBand", (0, 0, 4.45), 1.3, 0.3, M["StoneDark"], P, verts=16)
cyl("TowerBand2", (0, 0, 1.4), 1.22, 0.16, M["StoneDark"], P, verts=16)
cone("TowerRoof", (0, 0, 5.6), 1.45, 2.2, M["RoofDark"], P, verts=16)
cone("Snow_TowerRoof", (0, 0, 5.75), 1.5, 2.2, M["Snow"], P, verts=16)
cyl("Spire", (0, 0, 6.85), 0.05, 0.9, M["Iron"], P, verts=6)
box("Flag", (0.22, 0, 7.1), (0.44, 0.03, 0.26), M["Flag"], P, bevel=0.0)
door(P, 0, -1.15)
for a in (0.9, 2.3, 3.9, 5.4):
    x, y = math.cos(a) * 1.16, math.sin(a) * 1.16
    box(f"Slit{a:.1f}", (x, y, 3.2), (0.16, 0.12, 0.6), M["WindowGlass"], P, rot=(0, 0, a), bevel=0.0)
for i in range(10):
    a = i / 10 * math.tau
    box(f"Merlon{i}", (math.cos(a) * 1.3, math.sin(a) * 1.3, 4.75), (0.34, 0.24, 0.3), M["Stone"], P, rot=(0, 0, a), bevel=0.0)

# ---------------------------------------------------------------- 5. Forge (open smithy)
P = kit("Forge")
W, D, H = 3.6, 2.6, 1.9
box("ForgeFloor", (0, 0, 0.06), (W + 0.6, D + 0.6, 0.12), M["StoneDark"], P, bevel=0.01)
box("BackWall", (0, D / 2 - 0.1, H / 2), (W, 0.2, H), M["Stone"], P)
box("SideWallL", (-W / 2 + 0.1, 0.3, H / 2), (0.2, D - 0.6, H), M["Stone"], P)
box("HalfWallR", (W / 2 - 0.1, 0.3, 0.3), (0.2, D - 0.6, 0.6), M["Stone"], P)
for px in (-W / 2 + 0.15, W / 2 - 0.15):
    cyl(f"Post{px:.1f}", (px, -D / 2 + 0.15, H / 2 + 0.2), 0.09, H + 0.4, M["Timber"], P, verts=8)
lean_to("ForgeRoof", (0, 0.1, 0), W + 0.7, D + 0.6, H + 0.35, H + 0.9, M["RoofDark"], P)
box("Snow_ForgeRoof", (0, 0.1, H + 0.72), (W + 0.7, D + 0.5, 0.12), M["Snow"], P, rot=(-math.atan2(0.55, D + 0.6), 0, 0), bevel=0.03)
box("Hearth", (-0.9, D / 2 - 0.55, 0.4), (1.3, 0.8, 0.8), M["StoneDark"], P)
box("HearthRim", (-0.9, D / 2 - 0.55, 0.82), (1.36, 0.86, 0.08), M["Stone"], P, bevel=0.01)
box("Fire_Coals", (-0.9, D / 2 - 0.55, 0.86), (0.9, 0.5, 0.12), M["Fire"], P, bevel=0.0)
ball("Fire_Flame", (-0.9, D / 2 - 0.55, 1.05), 0.22, M["Fire"], P, scale=(1, 0.8, 1.5), sub=1)
box("Hood", (-0.9, D / 2 - 0.55, 1.35), (1.1, 0.6, 0.12), M["Iron"], P, bevel=0.01)
cyl("Flue", (-0.9, D / 2 - 0.55, H + 0.5), 0.16, 1.6, M["Iron"], P, verts=10)
AX, AY = 0.5, -0.2
cyl("Stump", (AX, AY, 0.25), 0.28, 0.5, M["Trunk"], P, verts=10)
box("AnvilBody", (AX, AY, 0.64), (0.7, 0.26, 0.22), M["Iron"], P, bevel=0.02)
box("AnvilWaist", (AX, AY, 0.55), (0.32, 0.22, 0.12), M["Iron"], P, bevel=0.0)
cone("AnvilHorn", (AX - 0.52, AY, 0.68), 0.1, 0.4, M["Iron"], P, rot=(0, -math.pi / 2, 0), verts=8)
box("HotBlade", (AX + 0.1, AY, 0.79), (0.5, 0.06, 0.05), M["HotMetal"], P, bevel=0.0)
box("HammerHead", (AX + 0.2, AY + 0.15, 0.82), (0.14, 0.08, 0.1), M["Iron"], P, bevel=0.01)
cyl("HammerHandle", (AX + 0.2, AY + 0.35, 0.82), 0.02, 0.4, M["Timber"], P, rot=(math.pi / 2, 0, 0), verts=6)
cyl("Bucket", (W / 2 - 0.5, 0.5, 0.22), 0.18, 0.44, M["Timber"], P, verts=10)
cyl("BucketWater", (W / 2 - 0.5, 0.5, 0.42), 0.15, 0.03, M["Water"], P, verts=10)
box("Rack", (0.9, D / 2 - 0.2, 1.3), (1.4, 0.06, 0.08), M["Timber"], P, bevel=0.0)
for i in range(4):
    cyl(f"Tool{i}", (0.4 + i * 0.32, D / 2 - 0.24, 1.0), 0.02, 0.5, M["Iron"], P, verts=6)
    box(f"ToolHead{i}", (0.4 + i * 0.32, D / 2 - 0.24, 1.28), (0.14, 0.05, 0.08), M["Iron"], P, bevel=0.0)
cyl("Grindstone", (-1.3, -0.6, 0.45), 0.35, 0.12, M["StoneDark"], P, rot=(0, math.pi / 2, 0), verts=14)
box("GrindFrame", (-1.3, -0.6, 0.2), (0.16, 0.5, 0.4), M["Timber"], P)
box("Chest", (1.4, -0.9, 0.22), (0.6, 0.4, 0.44), M["Timber"], P)
box("ChestLid", (1.4, -0.9, 0.47), (0.64, 0.44, 0.08), M["WoodLight"], P)
box("SignArm", (-W / 2 - 0.3, -D / 2 + 0.15, 2.0), (0.6, 0.05, 0.05), M["Iron"], P, bevel=0.0)
box("Sign", (-W / 2 - 0.55, -D / 2 + 0.15, 1.7), (0.5, 0.05, 0.4), M["WoodLight"], P)
box("SignHammer", (-W / 2 - 0.55, -D / 2 + 0.11, 1.7), (0.22, 0.02, 0.08), M["Iron"], P, bevel=0.0)

# ---------------------------------------------------------------- 6. Well
P = kit("Well")
cyl("WellRing", (0, 0, 0.35), 0.75, 0.7, M["Stone"], P, verts=14)
cyl("WellHole", (0, 0, 0.66), 0.55, 0.1, M["Water"], P, verts=14)
for i in range(10):
    a = i / 10 * math.tau
    box(f"WellStone{i}", (math.cos(a) * 0.76, math.sin(a) * 0.76, 0.35 + (i % 2) * 0.2), (0.3, 0.22, 0.24), M["StoneDark"], P, rot=(0, 0, a), bevel=0.0)
for sx in (-1, 1):
    cyl(f"WellPost{sx}", (sx * 0.7, 0, 1.1), 0.06, 1.5, M["Timber"], P, verts=8)
wedge("WellRoof", (0, 0, 1.75), 1.9, 1.5, 0.6, M["RoofDark"], P)
box("Snow_WellRoof", (0, 0, 2.2), (1.9, 1.5, 0.14), M["Snow"], P, bevel=0.03)
cyl("WellAxle", (0, 0, 1.6), 0.04, 1.5, M["Iron"], P, rot=(0, math.pi / 2, 0), verts=6)
cyl("WellBucket", (0, 0, 1.1), 0.12, 0.2, M["Timber"], P, verts=8)
cyl("WellRope", (0, 0, 1.4), 0.01, 0.4, M["Rope"], P, verts=4)

# ---------------------------------------------------------------- 7. Lantern post
P = kit("LanternPost")
cyl("LPBase", (0, 0, 0.08), 0.16, 0.16, M["StoneDark"], P, verts=8)
cyl("LPPost", (0, 0, 1.0), 0.05, 1.9, M["Iron"], P, verts=8)
box("LPArm", (0.15, 0, 1.9), (0.34, 0.05, 0.05), M["Iron"], P, bevel=0.0)
box("LPCage", (0.32, 0, 1.68), (0.22, 0.22, 0.3), M["Iron"], P, bevel=0.01)
box("LPGlow", (0.32, 0, 1.68), (0.17, 0.17, 0.24), M["Lantern"], P, bevel=0.0)
cone("LPCap", (0.32, 0, 1.88), 0.18, 0.12, M["Iron"], P, verts=6)

# ---------------------------------------------------------------- 8. Fence
P = kit("Fence")
for i, fx in enumerate((-1.1, 0, 1.1)):
    box(f"FPost{i}", (fx, 0, 0.4), (0.12, 0.12, 0.8), M["Timber"], P, bevel=0.01)
box("FRailTop", (0, 0, 0.62), (2.3, 0.06, 0.09), M["WoodLight"], P, bevel=0.01)
box("FRailBot", (0, 0, 0.28), (2.3, 0.06, 0.09), M["WoodLight"], P, bevel=0.01)
box("Snow_FRail", (0, 0, 0.7), (2.3, 0.1, 0.06), M["Snow"], P, bevel=0.02)

# ---------------------------------------------------------------- 9. small props
P = kit("Crate")
box("CrateBody", (0, 0, 0.3), (0.6, 0.6, 0.6), M["WoodLight"], P)
for a in (0, math.pi / 2):
    box(f"CrateX{a:.1f}", (0, 0, 0.3), (0.64, 0.08, 0.64), M["Timber"], P, rot=(0, 0, a), bevel=0.0)
box("Snow_Crate", (0, 0, 0.63), (0.62, 0.62, 0.08), M["Snow"], P)

P = kit("Barrel")
cyl("BarrelBody", (0, 0, 0.36), 0.28, 0.72, M["Timber"], P, verts=12, r2=0.24)
cyl("BarrelBody2", (0, 0, 0.36), 0.24, 0.72, M["Timber"], P, verts=12, r2=0.28)
for z in (0.14, 0.58):
    cyl(f"Hoop{z}", (0, 0, z), 0.29, 0.06, M["Iron"], P, verts=12)
box("Snow_Barrel", (0, 0, 0.73), (0.5, 0.5, 0.06), M["Snow"], P)

P = kit("Cart")
box("CartBed", (0, 0, 0.55), (1.6, 0.9, 0.12), M["WoodLight"], P)
for sx in (-1, 1):
    box(f"CartSide{sx}", (0, sx * 0.42, 0.75), (1.6, 0.06, 0.32), M["Timber"], P, bevel=0.0)
box("CartBack", (0.77, 0, 0.75), (0.06, 0.9, 0.32), M["Timber"], P, bevel=0.0)
for sx in (-1, 1):
    cyl(f"Wheel{sx}", (0.2, sx * 0.5, 0.36), 0.36, 0.08, M["Timber"], P, rot=(math.pi / 2, 0, 0), verts=12)
    cyl(f"Hub{sx}", (0.2, sx * 0.55, 0.36), 0.08, 0.06, M["Iron"], P, rot=(math.pi / 2, 0, 0), verts=8)
cyl("Axle", (0.2, 0, 0.36), 0.04, 1.1, M["Iron"], P, rot=(math.pi / 2, 0, 0), verts=6)
for sy in (-0.25, 0.25):
    cyl(f"Shaft{sy}", (-1.2, sy, 0.45), 0.04, 1.0, M["Timber"], P, rot=(0, math.pi / 2, 0), verts=6)
cyl("Leg", (-0.7, 0, 0.25), 0.05, 0.5, M["Timber"], P, verts=6)
for i in range(3):
    ball(f"CartHay{i}", (-0.3 + i * 0.35, 0, 0.8), 0.28, M["Hay"], P, scale=(1, 1, 0.7), sub=1)

P = kit("Campfire")
for i in range(8):
    a = i / 8 * math.tau
    ball(f"CFStone{i}", (math.cos(a) * 0.55, math.sin(a) * 0.55, 0.1), 0.14, M["StoneDark"], P, scale=(1.3, 1, 0.8), sub=1)
for i in range(3):
    cyl(f"CFLog{i}", (0, 0, 0.12), 0.07, 0.8, M["Trunk"], P, rot=(0, math.pi / 2, i * 1.05), verts=6)
ball("Fire_CF", (0, 0, 0.35), 0.24, M["Fire"], P, scale=(1, 1, 1.6), sub=1)
ball("Fire_CF2", (0.08, 0.05, 0.55), 0.12, M["Fire"], P, scale=(1, 1, 1.5), sub=1)

P = kit("Logpile")
for k in range(3):
    for j in range(3 - k):
        cyl(f"LPLog{k}{j}", (0, -0.3 + j * 0.3 + k * 0.15, 0.13 + k * 0.24), 0.13, 1.0, M["Trunk"], P, rot=(0, math.pi / 2, 0), verts=8)
box("Snow_Logs", (0, 0, 0.7), (1.0, 0.5, 0.06), M["Snow"], P)

P = kit("Hay")
ball("HayBale", (0, 0, 0.4), 0.45, M["Hay"], P, scale=(1, 1, 0.85), sub=1)
ball("HayBale2", (0.5, 0.3, 0.3), 0.32, M["Hay"], P, scale=(1, 1, 0.85), sub=1)

P = kit("Signpost")
cyl("SPPost", (0, 0, 0.9), 0.05, 1.8, M["Timber"], P, verts=8)
box("SPBoard", (0.25, 0, 1.55), (0.7, 0.06, 0.24), M["WoodLight"], P)
box("SPBoard2", (-0.2, 0, 1.25), (0.6, 0.06, 0.22), M["WoodLight"], P, rot=(0, 0, 0.6))

# ---------------------------------------------------------------- trees
P = kit("Oak")
cyl("OakTrunk", (0, 0, 0.7), 0.2, 1.4, M["Trunk"], P, verts=8, r2=0.15)
cyl("OakBranch", (0.2, -0.1, 1.2), 0.08, 0.7, M["Trunk"], P, rot=(0.3, 0.9, 0), verts=6)
blobs = ((0, 0, 2.0, 1.0), (-0.5, 0.3, 2.45, 0.72), (0.5, -0.25, 2.5, 0.66), (0.1, 0.55, 2.65, 0.55), (-0.2, -0.55, 2.6, 0.55), (0.05, 0.05, 3.0, 0.5))
for i, (dx, dy, dz, r) in enumerate(blobs):
    ball(f"OakLeaves{i}", (dx, dy, dz), r, M["Leaves"] if i % 2 == 0 else M["LeavesDark"], P, sub=1)
    ball(f"Snow_Oak{i}", (dx, dy, dz + r * 0.55), r * 0.9, M["Snow"], P, scale=(1, 1, 0.35), sub=1)

P = kit("Oak2")
cyl("Oak2Trunk", (0, 0, 0.55), 0.16, 1.1, M["Trunk"], P, verts=8, r2=0.12)
for i, (dx, dy, dz, r) in enumerate(((0, 0, 1.5, 0.75), (-0.35, 0.25, 1.9, 0.5), (0.35, -0.2, 1.95, 0.46), (0.0, 0.1, 2.3, 0.42))):
    ball(f"Oak2Leaves{i}", (dx, dy, dz), r, M["LeavesDark"] if i % 2 == 0 else M["Leaves"], P, sub=1)
    ball(f"Snow_Oak2{i}", (dx, dy, dz + r * 0.55), r * 0.9, M["Snow"], P, scale=(1, 1, 0.35), sub=1)

P = kit("Pine")
cyl("PineTrunk", (0, 0, 0.6), 0.16, 1.2, M["Trunk"], P, verts=8, r2=0.12)
for i, (z, r, h) in enumerate(((1.3, 1.05, 1.3), (2.1, 0.8, 1.2), (2.85, 0.55, 1.0))):
    cone(f"PineTier{i}", (0, 0, z), r, h, M["Pine"], P, verts=9)
    cone(f"Snow_Pine{i}", (0, 0, z + h * 0.35), r * 0.62, h * 0.55, M["Snow"], P, verts=9)

P = kit("DeadTree")
cyl("DTTrunk", (0, 0, 1.0), 0.18, 2.0, M["DeadWood"], P, verts=7, r2=0.09)
for i, (rx, ry, rz, h) in enumerate(((0.5, 0.0, 0.3, 1.1), (-0.5, 0.2, 2.2, 0.9), (0.2, -0.6, 4.2, 0.8), (0.0, 0.55, 1.4, 0.7))):
    cyl(f"DTBranch{i}", (math.cos(rz) * 0.35, math.sin(rz) * 0.35, 1.6 + i * 0.25), 0.06, h, M["DeadWood"], P, rot=(rx, ry, rz), verts=5, r2=0.02)

P = kit("Stump")
cyl("StumpBody", (0, 0, 0.22), 0.32, 0.44, M["Trunk"], P, verts=9, r2=0.28)
cyl("StumpTop", (0, 0, 0.45), 0.26, 0.03, M["WoodLight"], P, verts=9)
for i in range(3):
    a = i * 2.1
    box(f"StumpRoot{i}", (math.cos(a) * 0.36, math.sin(a) * 0.36, 0.06), (0.3, 0.14, 0.12), M["Trunk"], P, rot=(0, 0, a), bevel=0.0)

# ---------------------------------------------------------------- rocks & ruins
P = kit("Rock_S")
ball("RockS", (0, 0, 0.2), 0.35, M["Stone"], P, scale=(1.3, 1.0, 0.7), sub=1)
ball("RockS2", (0.3, 0.15, 0.12), 0.2, M["StoneDark"], P, scale=(1.1, 1.0, 0.7), sub=1)
box("Snow_RockS", (0, 0, 0.4), (0.6, 0.45, 0.06), M["Snow"], P, bevel=0.02)

P = kit("Rock_L")
ball("RockL", (0, 0, 0.5), 0.95, M["Stone"], P, scale=(1.3, 1.0, 0.75), sub=1, rot=(0.2, 0.1, 0.5))
ball("RockL2", (0.8, -0.3, 0.3), 0.5, M["StoneDark"], P, scale=(1.1, 1.0, 0.7), sub=1)
ball("RockL3", (-0.7, 0.5, 0.25), 0.4, M["StoneDark"], P, scale=(1.0, 1.2, 0.6), sub=1)
box("Snow_RockL", (0, 0, 1.05), (1.5, 1.2, 0.08), M["Snow"], P, bevel=0.03)

P = kit("Boulder")
ball("Boulder", (0, 0, 0.8), 1.5, M["StoneDark"], P, scale=(1.2, 1.0, 0.8), sub=1, rot=(0.3, 0.2, 1.0))
ball("BoulderMoss", (0.2, 0.1, 1.55), 0.9, M["Moss"], P, scale=(1.2, 1.0, 0.3), sub=1)
box("Snow_Boulder", (0, 0, 1.75), (2.2, 1.8, 0.1), M["Snow"], P, bevel=0.04)

P = kit("Column")
cyl("ColBase", (0, 0, 0.15), 0.55, 0.3, M["Stone"], P, verts=10)
cyl("ColShaft", (0, 0, 1.4), 0.34, 2.2, M["Stone"], P, verts=10, r2=0.3)
for i in range(6):
    a = i / 6 * math.tau
    box(f"Flute{i}", (math.cos(a) * 0.33, math.sin(a) * 0.33, 1.4), (0.08, 0.16, 2.1), M["StoneDark"], P, rot=(0, 0, a), bevel=0.0)
cyl("ColTop", (0, 0, 2.6), 0.42, 0.25, M["StoneDark"], P, verts=10)
ball("ColMoss", (0.1, 0.1, 0.35), 0.35, M["Moss"], P, scale=(1.4, 1.2, 0.5), sub=1)

P = kit("BrokenColumn")
cyl("BCBase", (0, 0, 0.15), 0.55, 0.3, M["Stone"], P, verts=10)
cyl("BCShaft", (0, 0, 0.7), 0.34, 0.9, M["Stone"], P, verts=10, r2=0.32)
box("BCTop", (0, 0, 1.2), (0.6, 0.6, 0.3), M["Stone"], P, rot=(0.25, 0.15, 0), bevel=0.02)
cyl("BCFallen", (1.2, 0.5, 0.3), 0.32, 1.6, M["StoneDark"], P, rot=(0.1, math.pi / 2, 0.4), verts=10)
ball("BCMoss", (0.9, 0.5, 0.55), 0.4, M["Moss"], P, scale=(1.3, 1.0, 0.4), sub=1)

P = kit("RuinWall")
box("RWBase", (0, 0, 0.4), (3.0, 0.5, 0.8), M["Stone"], P)
box("RWLeft", (-1.1, 0, 1.4), (0.8, 0.5, 1.2), M["StoneDark"], P)
box("RWMid", (0.0, 0, 1.1), (0.9, 0.5, 0.6), M["Stone"], P)
box("RWRight", (1.15, 0, 1.75), (0.7, 0.5, 1.9), M["StoneDark"], P)
box("RWRubble", (1.9, 0.5, 0.2), (0.6, 0.5, 0.4), M["Stone"], P, rot=(0, 0, 0.5))
ball("RWMoss", (-0.6, -0.26, 0.9), 0.5, M["Moss"], P, scale=(1.3, 0.2, 1.0), sub=1)
box("Snow_RW", (0, 0, 0.83), (3.0, 0.5, 0.08), M["Snow"], P, bevel=0.02)

P = kit("RuinArch")
for sx in (-1, 1):
    box(f"RAPillar{sx}", (sx * 1.2, 0, 1.2), (0.6, 0.6, 2.4), M["Stone"], P)
for i in range(7):
    a = math.pi * i / 6
    box(f"RAStone{i}", (math.cos(a) * 1.25, 0, 2.3 + math.sin(a) * 1.1), (0.5, 0.55, 0.45), M["StoneDark"] if i % 2 else M["Stone"], P, rot=(0, -a + math.pi / 2, 0), bevel=0.0)
ball("RAMoss", (-1.2, -0.3, 1.5), 0.4, M["Moss"], P, scale=(1.0, 0.3, 1.3), sub=1)

P = kit("Shrine")
box("ShrineBase", (0, 0, 0.2), (1.8, 1.8, 0.4), M["StoneDark"], P)
box("ShrineStep", (0, 0, 0.5), (1.2, 1.2, 0.24), M["Stone"], P)
cone("Obelisk", (0, 0, 1.8), 0.32, 2.5, M["StoneDark"], P, verts=4, r2=0.12)
ball("EmberCore_Gem", (0, 0, 3.2), 0.28, M["EmberCore"], P, sub=1)
for i in range(4):
    a = i / 4 * math.tau + 0.4
    cyl(f"ShrinePost{i}", (math.cos(a) * 0.8, math.sin(a) * 0.8, 0.9), 0.06, 0.6, M["Iron"], P, verts=6)
    box(f"ShrineLamp{i}", (math.cos(a) * 0.8, math.sin(a) * 0.8, 1.3), (0.16, 0.16, 0.2), M["Lantern"], P, bevel=0.0)

# ---------------------------------------------------------------- ground cover
P = kit("Bush")
ball("BushA", (0, 0, 0.35), 0.5, M["Bush"], P, scale=(1.1, 1, 0.8), sub=1)
ball("BushB", (0.4, 0.2, 0.28), 0.35, M["Bush"], P, scale=(1, 1, 0.8), sub=1)
ball("Snow_Bush", (0.1, 0.05, 0.62), 0.5, M["Snow"], P, scale=(1.1, 1, 0.3), sub=1)

P = kit("Tuft")
for i in range(5):
    a = i / 5 * math.tau
    cone(f"Blade{i}", (math.cos(a) * 0.1, math.sin(a) * 0.1, 0.22), 0.06, 0.5, M["Grass"], P, rot=(math.sin(a) * 0.35, math.cos(a) * 0.35, 0), verts=4)

P = kit("Mushroom")
cyl("MStem", (0, 0, 0.18), 0.07, 0.36, M["MushroomStem"], P, verts=7)
ball("MCap", (0, 0, 0.38), 0.2, M["Mushroom"], P, scale=(1, 1, 0.6), sub=1)
cyl("MStem2", (0.28, 0.1, 0.1), 0.05, 0.2, M["MushroomStem"], P, verts=7)
ball("MCap2", (0.28, 0.1, 0.22), 0.12, M["Mushroom"], P, scale=(1, 1, 0.6), sub=1)

P = kit("Reed")
for i in range(6):
    a = i / 6 * math.tau
    cyl(f"ReedStem{i}", (math.cos(a) * 0.18, math.sin(a) * 0.18, 0.55), 0.025, 1.1 + (i % 3) * 0.2, M["Reed"], P, rot=(math.sin(a) * 0.1, math.cos(a) * 0.1, 0), verts=4)
    cyl(f"ReedHead{i}", (math.cos(a) * 0.2, math.sin(a) * 0.2, 1.05 + (i % 3) * 0.2), 0.05, 0.25, M["Trunk"], P, verts=5)

P = kit("EmberRock")
ball("ERock", (0, 0, 0.25), 0.5, M["Ash"], P, scale=(1.3, 1.0, 0.7), sub=1)
for i in range(4):
    a = i / 4 * math.tau
    box(f"EmberCore_Crack{i}", (math.cos(a) * 0.35, math.sin(a) * 0.3, 0.28), (0.25, 0.05, 0.12), M["EmberCore"], P, rot=(0, 0, a), bevel=0.0)

# ---------------------------------------------------------------- pickups
P = kit("Ember")
ball("Crystal_Ember", (0, 0, 0.35), 0.22, M["Crystal"], P, scale=(0.7, 0.7, 1.3), sub=0)

P = kit("Shard")
for i, (dx, dy, h, r) in enumerate(((0, 0, 0.5, 0.11), (0.14, 0.06, 0.34, 0.08), (-0.1, 0.1, 0.3, 0.07))):
    cone(f"Crystal_Shard{i}", (dx, dy, h / 2), r, h, M["ShardCrystal"], P, verts=5)

P = kit("Heart")
ball("EmberCore_HeartA", (-0.12, 0, 0.42), 0.16, M["EmberCore"], P, sub=1)
ball("EmberCore_HeartB", (0.12, 0, 0.42), 0.16, M["EmberCore"], P, sub=1)
cone("EmberCore_HeartC", (0, 0, 0.26), 0.25, 0.3, M["EmberCore"], P, verts=4, r2=0.0)

# ---------------------------------------------------------------- Player rig
P = kit("Player")
body = empty("P_Body"); body.parent = P
cone("Cloak", (0, 0, 0.55), 0.42, 1.1, M["Cloak"], body, verts=12, r2=0.22)
cyl("Belt", (0, 0, 0.78), 0.28, 0.08, M["Belt"], body, verts=12)
box("Buckle", (0, -0.28, 0.78), (0.1, 0.04, 0.1), M["HotMetal"], body, bevel=0.0)
for sx in (-1, 1):
    box(f"Boot{sx}", (sx * 0.13, -0.03, 0.06), (0.14, 0.24, 0.12), M["Boot"], body, bevel=0.01)
cyl("Collar", (0, 0, 1.1), 0.26, 0.12, M["CloakDark"], body, verts=12, r2=0.32)
head = empty("P_Head"); head.parent = body; head.location = (0, 0, 1.18)
ball("Head", (0, 0, 0.22), 0.24, M["Skin"], head, sub=1)
ball("Hair", (0, 0.04, 0.32), 0.25, M["Hair"], head, scale=(1, 1, 0.8), sub=1)
cone("Hood", (0, 0.05, 0.42), 0.34, 0.5, M["CloakDark"], head, verts=10, r2=0.06, rot=(0.25, 0, 0))
for sx in (-1, 1):
    ball(f"Eye{sx}", (sx * 0.09, -0.21, 0.22), 0.035, M["Hair"], head, sub=0)
arm_l = empty("P_ArmL"); arm_l.parent = body; arm_l.location = (-0.36, 0, 1.0)
cyl("ArmL", (0, -0.05, -0.28), 0.08, 0.55, M["Cloak"], arm_l, verts=8, rot=(-0.2, 0, 0))
ball("HandL", (0, -0.12, -0.56), 0.08, M["Skin"], arm_l, sub=0)
lan = empty("P_Lantern"); lan.parent = arm_l; lan.location = (0, -0.15, -0.6)
cyl("LanHook", (0, 0, -0.06), 0.015, 0.12, M["Iron"], lan, verts=4)
box("LanCage", (0, 0, -0.26), (0.18, 0.18, 0.26), M["Iron"], lan, bevel=0.01)
box("PlayerLamp_Glow", (0, 0, -0.26), (0.14, 0.14, 0.2), M["PlayerLamp"], lan, bevel=0.0)
cone("LanCap", (0, 0, -0.1), 0.14, 0.08, M["Iron"], lan, verts=6)
arm_r = empty("P_ArmR"); arm_r.parent = body; arm_r.location = (0.36, 0, 1.0)
cyl("ArmR", (0, -0.05, -0.28), 0.08, 0.55, M["Cloak"], arm_r, verts=8, rot=(-0.2, 0, 0))
ball("HandR", (0, -0.12, -0.56), 0.08, M["Skin"], arm_r, sub=0)
blade = empty("P_Blade"); blade.parent = arm_r; blade.location = (0, -0.15, -0.58)
cyl("Hilt", (0, 0, 0), 0.03, 0.3, M["Belt"], blade, verts=6, rot=(math.pi / 2, 0, 0))
arc("HotMetal_Crescent", (0, -0.35, 0), 0.32, 0.5, math.radians(200), math.radians(340), 0.03, M["HotMetal"], blade)

# ---------------------------------------------------------------- enemies (Z up; front = -Y)
def eyes(P, y, z, sep=0.12, r=0.05):
    for sx in (-1, 1):
        ball(f"EnemyEye_{sx}", (sx * sep, y, z), r, M["EnemyEye"], P, sub=0)

P = kit("Wisp")
ball("WispBody", (0, 0, 0.55), 0.28, M["Ash"], P, scale=(1, 1, 1.15), sub=1)
eyes(P, -0.22, 0.6, sep=0.1, r=0.05)
for i in range(3):
    ball(f"WispTail{i}", (0.1 * (i % 2 - 0.5), 0.28 + i * 0.18, 0.5 - i * 0.05), 0.16 - i * 0.04, M["AshLight"], P, sub=0)

P = kit("Cinder")
ball("CinderBody", (0, 0, 0.5), 0.45, M["Ash"], P, scale=(1, 1, 0.95), sub=1)
eyes(P, -0.36, 0.58, sep=0.15, r=0.07)
for sx in (-1, 1):
    ball(f"CFoot{sx}", (sx * 0.22, -0.05, 0.08), 0.13, M["AshLight"], P, scale=(1, 1.3, 0.6), sub=0)
for i in range(5):
    a = i / 5 * math.tau
    box(f"EmberCore_Vein{i}", (math.cos(a) * 0.4, math.sin(a) * 0.4, 0.45 + (i % 2) * 0.15), (0.16, 0.05, 0.08), M["EmberCore"], P, rot=(0, 0, a + 0.4), bevel=0.0)

P = kit("Crawler")
ball("CrawlBody", (0, 0, 0.35), 0.4, M["Ash"], P, scale=(1.0, 1.4, 0.55), sub=1)
ball("CrawlHead", (0, -0.5, 0.35), 0.22, M["AshLight"], P, sub=1)
eyes(P, -0.68, 0.4, sep=0.09, r=0.05)
for sx in (-1, 1):
    for i in range(3):
        y = -0.3 + i * 0.3
        cyl(f"Leg{sx}{i}", (sx * 0.45, y, 0.28), 0.04, 0.6, M["AshLight"], P, rot=(0, sx * 1.0, 0), verts=5)
        cyl(f"Leg2{sx}{i}", (sx * 0.72, y, 0.12), 0.03, 0.35, M["Ash"], P, rot=(0, sx * 0.3, 0), verts=5)

P = kit("Spitter")
ball("SpitBody", (0, 0, 0.55), 0.5, M["Ash"], P, scale=(0.9, 0.9, 1.1), sub=1)
ball("EmberCore_Maw", (0, -0.42, 0.45), 0.24, M["EmberCore"], P, scale=(1, 0.5, 0.8), sub=1)
eyes(P, -0.4, 0.78, sep=0.16, r=0.06)
for i in range(3):
    cone(f"Spike{i}", (-0.2 + i * 0.2, 0.2, 1.05), 0.08, 0.4, M["AshLight"], P, verts=5, rot=(0.3, 0, 0))
for sx in (-1, 1):
    ball(f"SFoot{sx}", (sx * 0.25, -0.05, 0.08), 0.14, M["AshLight"], P, scale=(1, 1.3, 0.6), sub=0)

P = kit("Brute")
ball("BruteBody", (0, 0, 0.9), 0.8, M["Ash"], P, scale=(1.05, 0.95, 1.0), sub=1)
ball("BruteHead", (0, -0.55, 1.35), 0.38, M["AshLight"], P, sub=1)
eyes(P, -0.9, 1.4, sep=0.16, r=0.08)
for sx in (-1, 1):
    cone(f"Horn{sx}", (sx * 0.3, -0.5, 1.7), 0.09, 0.5, M["Horn"], P, verts=6, rot=(0.3, sx * 0.5, 0))
    cyl(f"BArm{sx}", (sx * 0.85, -0.1, 0.8), 0.16, 1.0, M["Ash"], P, rot=(0.2, 0, 0), verts=8)
    ball(f"BFist{sx}", (sx * 0.9, -0.25, 0.28), 0.24, M["AshLight"], P, sub=1)
    box(f"BLeg{sx}", (sx * 0.35, 0.05, 0.18), (0.36, 0.5, 0.36), M["AshLight"], P)
for i in range(6):
    a = i / 6 * math.tau
    box(f"EmberCore_BVein{i}", (math.cos(a) * 0.75, math.sin(a) * 0.7, 0.85 + (i % 2) * 0.25), (0.28, 0.06, 0.12), M["EmberCore"], P, rot=(0, 0, a + 0.4), bevel=0.0)

# Boss: Ash Warden (rig)
P = kit("Warden")
wb = empty("W_Body"); wb.parent = P
cone("WCloak", (0, 0, 1.4), 1.0, 2.8, M["Warden"], wb, verts=14, r2=0.45)
cyl("WCollar", (0, 0, 2.8), 0.55, 0.3, M["WardenTrim"], wb, verts=14, r2=0.75)
cyl("WBelt", (0, 0, 1.6), 0.72, 0.16, M["WardenTrim"], wb, verts=14)
for i in range(6):
    a = i / 6 * math.tau
    box(f"EmberCore_WVein{i}", (math.cos(a) * 0.72, math.sin(a) * 0.72, 1.0 + (i % 3) * 0.4), (0.3, 0.06, 0.16), M["EmberCore"], wb, rot=(0, 0, a + 0.3), bevel=0.0)
ball("EmberCore_WHeart", (0, -0.6, 2.0), 0.24, M["EmberCore"], wb, sub=1)
wh = empty("W_Head"); wh.parent = wb; wh.location = (0, 0, 2.95)
ball("WHead", (0, 0, 0.35), 0.42, M["Ash"], wh, sub=1)
cone("WHood", (0, 0.1, 0.75), 0.6, 0.9, M["Warden"], wh, verts=12, r2=0.08, rot=(0.3, 0, 0))
for sx in (-1, 1):
    ball(f"EnemyEye_W{sx}", (sx * 0.16, -0.36, 0.38), 0.09, M["EnemyEye"], wh, sub=0)
    cone(f"WHorn{sx}", (sx * 0.4, 0.0, 0.7), 0.12, 1.1, M["Horn"], wh, verts=6, rot=(0.2, sx * 0.9, 0))
    cone(f"WHorn2{sx}", (sx * 0.25, -0.1, 0.85), 0.07, 0.6, M["Bone"], wh, verts=5, rot=(-0.2, sx * 0.4, 0))
wl = empty("W_ArmL"); wl.parent = wb; wl.location = (-0.85, 0, 2.5)
cyl("WArmL", (0, -0.1, -0.6), 0.17, 1.2, M["Warden"], wl, verts=8, rot=(-0.3, 0, 0))
ball("WFistL", (0, -0.35, -1.2), 0.22, M["AshLight"], wl, sub=1)
wr = empty("W_ArmR"); wr.parent = wb; wr.location = (0.85, 0, 2.5)
cyl("WArmR", (0, -0.1, -0.6), 0.17, 1.2, M["Warden"], wr, verts=8, rot=(-0.3, 0, 0))
ball("WFistR", (0, -0.35, -1.2), 0.22, M["AshLight"], wr, sub=1)
wbl = empty("W_Blade"); wbl.parent = wr; wbl.location = (0, -0.4, -1.25)
cyl("WHilt", (0, 0, 0), 0.05, 0.7, M["WardenTrim"], wbl, verts=6, rot=(math.pi / 2, 0, 0))
arc("EmberCore_WCrescent", (0, -0.8, 0), 0.7, 1.15, math.radians(195), math.radians(345), 0.06, M["EmberCore"], wbl)
arc("WCrescentEdge", (0, -0.8, 0), 0.62, 0.72, math.radians(200), math.radians(340), 0.05, M["Bone"], wbl)

# ---------------------------------------------------------------- district elites (mini-bosses), rig: M<n>_Body / M<n>_Head / M<n>_ArmL / M<n>_ArmR
MINI = {}
def mini_rig(n, name):
    P = kit(name)
    body = empty(f"M{n}_Body"); body.parent = P
    head = empty(f"M{n}_Head"); head.parent = body
    al = empty(f"M{n}_ArmL"); al.parent = body
    ar = empty(f"M{n}_ArmR"); ar.parent = body
    MINI[n] = {"body": body, "head": head, "armL": al, "armR": ar}
    return P, body, head, al, ar

M["Fur"] = mat("Fur", "#5a4a3c"); M["FurLight"] = mat("FurLight", "#8a7660"); M["Fang"] = mat("Fang", "#efe6d2")
M["Golem"] = mat("Golem", "#6f7a72"); M["GolemDark"] = mat("GolemDark", "#4a524d")
M["Scale"] = mat("Scale", "#3a2b2a"); M["ScaleBelly"] = mat("ScaleBelly", "#7a4a3a")
M["Mud"] = mat("Mud", "#3f4a3a"); M["MudLight"] = mat("MudLight", "#5a6a50"); M["Gum"] = mat("Gum", "#7a2f3a")

# 1. Wolf King (wildwood) — quadruped; head & jaw on the head empty, front legs on the arm empties
P, body, head, al, ar = mini_rig(1, "WolfKing")
ball("WKBody", (0, 0.1, 1.0), 0.75, M["Fur"], body, scale=(0.9, 1.5, 0.8), sub=1)
ball("WKChest", (0, -0.7, 1.05), 0.55, M["FurLight"], body, scale=(1.0, 0.9, 0.9), sub=1)
cyl("WKTail", (0, 1.25, 1.2), 0.1, 1.0, M["Fur"], body, rot=(-0.9, 0, 0), verts=6, r2=0.04)
for sx in (-1, 1):
    cyl(f"WKHind{sx}", (sx * 0.42, 0.7, 0.45), 0.13, 0.9, M["Fur"], body, verts=7, r2=0.09)
    ball(f"WKPawH{sx}", (sx * 0.42, 0.62, 0.08), 0.15, M["FurLight"], body, scale=(1, 1.3, 0.6), sub=0)
head.location = (0, -1.2, 1.25)
ball("WKHead", (0, -0.1, 0), 0.4, M["Fur"], head, scale=(0.9, 1.1, 0.85), sub=1)
box("WKSnout", (0, -0.55, -0.08), (0.36, 0.5, 0.3), M["FurLight"], head, bevel=0.03)
box("WKJaw", (0, -0.5, -0.24), (0.32, 0.42, 0.1), M["Fur"], head, bevel=0.02)
for sx in (-1, 1):
    cone(f"WKEar{sx}", (sx * 0.22, 0.1, 0.36), 0.12, 0.35, M["Fur"], head, verts=5)
    ball(f"EnemyEye_WK{sx}", (sx * 0.17, -0.34, 0.1), 0.06, M["EnemyEye"], head, sub=0)
    cone(f"WKFang{sx}", (sx * 0.1, -0.72, -0.14), 0.04, 0.16, M["Fang"], head, verts=4, r2=0.0)
for i in range(5):
    cone(f"WKMane{i}", (-0.3 + i * 0.15, 0.25, 0.32 + (i % 2) * 0.05), 0.09, 0.4, M["FurLight"], head, verts=4, rot=(0.6, 0, 0))
for emp, sx in ((al, -1), (ar, 1)):
    emp.location = (sx * 0.45, -0.75, 0.95)
    cyl("WKForeleg", (0, 0, -0.45), 0.12, 0.9, M["Fur"], emp, verts=7, r2=0.09)
    ball("WKPaw", (0, -0.05, -0.85), 0.15, M["FurLight"], emp, scale=(1, 1.3, 0.6), sub=0)

# 2. Stone Sentinel (mossfall) — stone golem
P, body, head, al, ar = mini_rig(2, "Sentinel")
box("SGTorso", (0, 0, 1.6), (1.5, 1.0, 1.4), M["Golem"], body, bevel=0.08)
box("SGHips", (0, 0, 0.75), (1.1, 0.8, 0.5), M["GolemDark"], body, bevel=0.06)
for sx in (-1, 1):
    box(f"SGLeg{sx}", (sx * 0.4, 0, 0.3), (0.45, 0.55, 0.6), M["GolemDark"], body, bevel=0.05)
ball("SGMoss", (0.3, -0.3, 2.1), 0.4, M["Moss"], body, scale=(1.3, 0.5, 0.6), sub=1)
for i in range(4):
    a = i / 4 * math.tau
    box(f"EmberCore_SGRune{i}", (math.cos(a) * 0.55, -0.52, 1.5 + (i % 2) * 0.3), (0.2, 0.05, 0.12), M["EmberCore"], body, rot=(0, 0, a), bevel=0.0)
head.location = (0, 0, 2.35)
box("SGHead", (0, 0, 0.35), (0.8, 0.7, 0.7), M["Golem"], head, bevel=0.06)
for sx in (-1, 1):
    ball(f"EnemyEye_SG{sx}", (sx * 0.2, -0.36, 0.38), 0.08, M["EnemyEye"], head, sub=0)
box("SGBrow", (0, -0.3, 0.6), (0.9, 0.25, 0.16), M["GolemDark"], head, bevel=0.03)
for emp, sx in ((al, -1), (ar, 1)):
    emp.location = (sx * 1.0, 0, 2.1)
    box("SGArm", (sx * 0.1, 0, -0.6), (0.5, 0.5, 1.2), M["Golem"], emp, bevel=0.06)
    box("SGFist", (sx * 0.1, -0.05, -1.35), (0.65, 0.6, 0.5), M["GolemDark"], emp, bevel=0.06)

# 3. Salamander (cinder) — long low lizard with an ember crest
P, body, head, al, ar = mini_rig(3, "Salamander")
ball("SLBody", (0, 0.2, 0.55), 0.6, M["Scale"], body, scale=(1.0, 2.2, 0.7), sub=1)
ball("SLBelly", (0, 0.2, 0.4), 0.5, M["ScaleBelly"], body, scale=(0.9, 2.0, 0.5), sub=1)
cyl("SLTail", (0, 1.9, 0.5), 0.22, 1.6, M["Scale"], body, rot=(math.pi / 2, 0, 0), verts=7, r2=0.05)
for i in range(6):
    cone(f"EmberCore_SLCrest{i}", (0, -0.6 + i * 0.4, 0.95), 0.1, 0.35 + (i % 2) * 0.1, M["EmberCore"], body, verts=4, rot=(0.3, 0, 0))
for sx in (-1, 1):
    cyl(f"SLHind{sx}", (sx * 0.6, 0.8, 0.28), 0.12, 0.55, M["Scale"], body, rot=(0, sx * 0.7, 0), verts=6)
    ball(f"SLFootH{sx}", (sx * 0.8, 0.85, 0.06), 0.14, M["ScaleBelly"], body, scale=(1.2, 1, 0.5), sub=0)
head.location = (0, -1.25, 0.6)
ball("SLHead", (0, -0.15, 0), 0.38, M["Scale"], head, scale=(0.9, 1.3, 0.7), sub=1)
box("SLJaw", (0, -0.45, -0.15), (0.5, 0.5, 0.12), M["ScaleBelly"], head, bevel=0.02)
ball("EmberCore_SLThroat", (0, -0.2, -0.05), 0.2, M["EmberCore"], head, scale=(1, 1.2, 0.6), sub=0)
for sx in (-1, 1):
    ball(f"EnemyEye_SL{sx}", (sx * 0.22, -0.25, 0.2), 0.07, M["EnemyEye"], head, sub=0)
for emp, sx in ((al, -1), (ar, 1)):
    emp.location = (sx * 0.62, -0.6, 0.5)
    cyl("SLForeleg", (sx * 0.15, 0, -0.22), 0.12, 0.55, M["Scale"], emp, rot=(0, sx * 0.7, 0), verts=6)
    ball("SLFoot", (sx * 0.3, 0, -0.44), 0.14, M["ScaleBelly"], emp, scale=(1.2, 1, 0.5), sub=0)

# 4. Maw (silvermere) — mud blob with a huge mouth; "arms" are the two mud tendrils
P, body, head, al, ar = mini_rig(4, "Maw")
ball("MWBody", (0, 0, 0.7), 1.1, M["Mud"], body, scale=(1.2, 1.1, 0.75), sub=1)
ball("MWBump", (0.5, 0.4, 1.2), 0.45, M["MudLight"], body, sub=1)
ball("MWBump2", (-0.6, 0.2, 1.1), 0.35, M["MudLight"], body, sub=1)
for i in range(6):
    a = i / 6 * math.tau
    ball(f"MWDrip{i}", (math.cos(a) * 1.15, math.sin(a) * 1.05, 0.12), 0.22, M["Mud"], body, scale=(1.3, 1.3, 0.5), sub=0)
head.location = (0, -0.75, 0.95)
ball("MWMouthTop", (0, -0.1, 0.15), 0.62, M["Mud"], head, scale=(1.2, 0.8, 0.5), sub=1)
ball("MWGum", (0, -0.2, 0.0), 0.5, M["Gum"], head, scale=(1.1, 0.8, 0.35), sub=1)
for i in range(7):
    cone(f"MWTooth{i}", (-0.45 + i * 0.15, -0.55, 0.05), 0.05, 0.22, M["Fang"], head, verts=4, rot=(math.pi, 0, 0))
for sx in (-1, 1):
    ball(f"EnemyEye_MW{sx}", (sx * 0.35, -0.2, 0.45), 0.09, M["EnemyEye"], head, sub=0)
for emp, sx in ((al, -1), (ar, 1)):
    emp.location = (sx * 1.0, -0.3, 0.9)
    cyl("MWTendril", (sx * 0.3, -0.3, 0.3), 0.16, 1.1, M["MudLight"], emp, rot=(0.5, sx * 0.6, 0), verts=7, r2=0.06)
    ball("MWTendrilTip", (sx * 0.62, -0.62, 0.7), 0.14, M["Mud"], emp, sub=0)

# ---------------------------------------------------------------- animations (keyframes on the rig empties, one NLA track per clip)
# Every clip starts from the rest pose at frame 0 so the web side can play the one-shots additively.
scene.render.fps = 24
RIG_P = {"body": body, "head": head, "armL": arm_l, "armR": arm_r}
RIG_W = {"body": wb, "head": wh, "armL": wl, "armR": wr}

def _rest(objs):
    for o in objs.values():
        o.rotation_euler = (0, 0, 0)
        o.location = (o.get("rest_x", o.location.x), o.get("rest_y", o.location.y), o.get("rest_z", o.location.z))

def clip(name, objs, frames, keys, loop=True):
    """keys: {objkey: {frame: {"rot": (x,y,z), "loc": (dx,dy,dz)}}} — loc is an offset from the rest location."""
    for o in objs.values():
        for k in ("rest_x", "rest_y", "rest_z"):
            if k not in o:
                o["rest_x"], o["rest_y"], o["rest_z"] = o.location.x, o.location.y, o.location.z
    for key, o in objs.items():
        if o.animation_data is None:
            o.animation_data_create()
        act = bpy.data.actions.new(f"{name}__{key}")
        o.animation_data.action = act
        kf = keys.get(key, {})
        frame_list = sorted(set([0, frames] + list(kf.keys())))
        for f in frame_list:
            rest = {"rot": (0, 0, 0), "loc": (0, 0, 0)}
            if f in kf:
                v = kf[f]
            elif f == 0 or not kf:
                v = rest
            else:
                # last frame: loops return to the frame-0 pose, one-shots hold the last authored pose
                v = kf.get(0, rest) if loop else kf[max(kf.keys())]
            rot = v.get("rot", (0, 0, 0)); loc = v.get("loc", (0, 0, 0))
            o.rotation_euler = rot
            o.location = (o["rest_x"] + loc[0], o["rest_y"] + loc[1], o["rest_z"] + loc[2])
            o.keyframe_insert(data_path="rotation_euler", frame=f)
            o.keyframe_insert(data_path="location", frame=f)
        o.animation_data.action = None
        track = o.animation_data.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, 0, act)
        strip.name = name
    _rest(objs)

R = lambda x=0, y=0, z=0: {"rot": (x, y, z)}
RL = lambda rot=(0, 0, 0), loc=(0, 0, 0): {"rot": rot, "loc": loc}

# ---- player
clip("P_idle", RIG_P, 48, {
    "body": {0: RL(), 24: RL((0.02, 0, 0), (0, 0, 0.02))},
    "head": {0: R(), 16: R(0, 0.12, 0), 36: R(0, -0.1, 0)},
    "armL": {0: R(-0.25), 24: R(-0.15)},
    "armR": {0: R(-0.2), 24: R(-0.3)},
})
clip("P_walk", RIG_P, 24, {
    "body": {0: RL((0.12, 0, 0.04), (0, 0, 0.0)), 6: RL((0.12, 0, 0), (0, 0, 0.07)), 12: RL((0.12, 0, -0.04), (0, 0, 0.0)), 18: RL((0.12, 0, 0), (0, 0, 0.07))},
    "head": {0: R(0.05, 0, 0), 12: R(-0.03, 0, 0)},
    "armL": {0: R(0.55), 12: R(-0.55)},
    "armR": {0: R(-0.55), 12: R(0.55)},
})
clip("P_attack", RIG_P, 14, {
    "armR": {0: R(), 3: R(0.7, 0.35, 0), 6: R(-2.1, -1.25, 0.2), 9: R(-1.6, -1.0, 0.1), 14: R()},
    "body": {0: R(), 3: R(0.0, -0.25, 0.05), 6: R(0.18, 0.35, -0.12), 14: R()},
    "armL": {0: R(), 6: R(0.5, 0, 0), 14: R()},
}, loop=False)
clip("P_dash", RIG_P, 12, {
    "body": {0: R(), 3: R(0.55, 0, 0), 9: R(0.5, 0, 0), 12: R()},
    "armL": {0: R(), 3: R(0.9, 0, 0), 12: R()},
    "armR": {0: R(), 3: R(0.9, 0, 0), 12: R()},
}, loop=False)

# ---- warden
clip("W_idle", RIG_W, 72, {
    "body": {0: RL(), 36: RL((0.03, 0, 0), (0, 0, 0.08))},
    "head": {0: R(), 24: R(0.05, 0.2, 0), 52: R(-0.05, -0.18, 0)},
    "armL": {0: R(-0.15), 36: R(-0.35, 0, 0.1)},
    "armR": {0: R(-0.15), 36: R(-0.3, 0, -0.1)},
})
clip("W_walk", RIG_W, 36, {
    "body": {0: RL((0.15, 0, 0.06), (0, 0, 0)), 9: RL((0.15, 0, 0), (0, 0, 0.16)), 18: RL((0.15, 0, -0.06), (0, 0, 0)), 27: RL((0.15, 0, 0), (0, 0, 0.16))},
    "head": {0: R(0.06), 18: R(-0.04)},
    "armL": {0: R(0.5), 18: R(-0.5)},
    "armR": {0: R(-0.5), 18: R(0.5)},
})
clip("W_slam", RIG_W, 24, {
    "armL": {0: R(), 12: R(-2.6, 0, 0.3), 16: R(-2.6, 0, 0.3), 19: R(0.9, 0, 0.1), 24: R(0.6, 0, 0)},
    "armR": {0: R(), 12: R(-2.6, 0, -0.3), 16: R(-2.6, 0, -0.3), 19: R(0.9, 0, -0.1), 24: R(0.6, 0, 0)},
    "body": {0: RL(), 12: RL((-0.15, 0, 0), (0, 0, 0.35)), 16: RL((-0.15, 0, 0), (0, 0, 0.35)), 19: RL((0.35, 0, 0), (0, 0, -0.45)), 24: RL((0.25, 0, 0), (0, 0, -0.3))},
    "head": {0: R(), 12: R(-0.4), 19: R(0.5), 24: R(0.4)},
}, loop=False)
clip("W_charge", RIG_W, 12, {
    "body": {0: RL((0.3, 0, 0), (0, 0, -0.1)), 6: RL((0.3, 0, 0), (0, 0, 0.0))},
    "armL": {0: R(1.3, 0, 0.2), 6: R(1.1, 0, 0.2)},
    "armR": {0: R(1.3, 0, -0.2), 6: R(1.1, 0, -0.2)},
    "head": {0: R(0.2), 6: R(0.25)},
})
clip("W_roar", RIG_W, 40, {
    "body": {0: RL(), 10: RL((-0.2, 0, 0), (0, 0, 0.7)), 26: RL((-0.25, 0, 0), (0, 0, 0.75)), 40: RL()},
    "armL": {0: R(), 10: R(-2.8, 0, 0.8), 26: R(-2.9, 0, 0.9), 40: R()},
    "armR": {0: R(), 10: R(-2.8, 0, -0.8), 26: R(-2.9, 0, -0.9), 40: R()},
    "head": {0: R(), 10: R(-0.55), 26: R(-0.6), 40: R()},
}, loop=False)
# ---- more player clips
clip("P_hurt", RIG_P, 10, {
    "body": {0: R(), 3: RL((-0.35, 0, 0), (0, 0.12, 0)), 10: R()},
    "armL": {0: R(), 3: R(-0.9, 0, 0.5), 10: R()},
    "armR": {0: R(), 3: R(-0.9, 0, -0.5), 10: R()},
    "head": {0: R(), 3: R(-0.4), 10: R()},
}, loop=False)
clip("P_death", RIG_P, 26, {
    "body": {0: RL(), 6: RL((-0.3, 0, 0), (0, 0, 0.06)), 16: RL((1.45, 0, 0.1), (0, -0.25, 0.22)), 26: RL((1.45, 0, 0.1), (0, -0.25, 0.22))},
    "armL": {0: R(), 6: R(-0.8, 0, 0.6), 16: R(1.3, 0, 0.9), 26: R(1.3, 0, 0.9)},
    "armR": {0: R(), 6: R(-0.8, 0, -0.6), 16: R(1.3, 0, -0.9), 26: R(1.3, 0, -0.9)},
    "head": {0: R(), 6: R(-0.5), 16: R(0.6), 26: R(0.6)},
}, loop=False)
clip("P_cheer", RIG_P, 22, {
    "armR": {0: R(), 6: R(-3.0, 0, -0.3), 14: R(-3.1, 0, 0.3), 22: R()},
    "armL": {0: R(), 6: R(-0.6, 0, 0.4), 22: R()},
    "body": {0: RL(), 6: RL((-0.1, 0, 0), (0, 0, 0.18)), 10: RL((-0.1, 0, 0), (0, 0, 0.0)), 14: RL((-0.1, 0, 0), (0, 0, 0.14)), 22: RL()},
    "head": {0: R(), 6: R(-0.35), 22: R()},
}, loop=False)
clip("P_heavy", RIG_P, 18, {
    "armR": {0: R(), 4: R(-2.9, 0.4, 0), 8: R(-2.9, 0.4, 0), 11: R(0.6, -0.9, 0.3), 18: R()},
    "armL": {0: R(), 4: R(-2.4, -0.4, 0), 8: R(-2.4, -0.4, 0), 11: R(0.5, 0.8, -0.3), 18: R()},
    "body": {0: RL(), 4: RL((-0.25, 0, 0), (0, 0, 0.1)), 8: RL((-0.25, 0, 0.3), (0, 0, 0.1)), 11: RL((0.45, 0, -0.35), (0, 0, -0.1)), 18: RL()},
    "head": {0: R(), 4: R(-0.3), 11: R(0.35), 18: R()},
}, loop=False)
clip("P_nova", RIG_P, 20, {
    "armR": {0: R(), 5: R(0.9, 0, -0.9), 10: R(-1.4, 0, -1.5), 20: R()},
    "armL": {0: R(), 5: R(0.9, 0, 0.9), 10: R(-1.4, 0, 1.5), 20: R()},
    "body": {0: RL(), 5: RL((0.25, 0, 0), (0, 0, -0.16)), 10: RL((-0.2, 0, 0), (0, 0, 0.22)), 20: RL()},
    "head": {0: R(), 5: R(0.3), 10: R(-0.45), 20: R()},
}, loop=False)
clip("P_look", RIG_P, 60, {
    "armL": {0: R(), 12: R(-0.9, 0, 0.35), 44: R(-0.9, 0, 0.35), 60: R()},
    "head": {0: R(), 12: R(0.25, 0, 0.45), 44: R(0.3, 0, 0.5), 60: R()},
    "body": {0: R(), 12: R(0.05, 0, 0.12), 44: R(0.05, 0, 0.12), 60: R()},
}, loop=False)

# ---- more warden clips
clip("W_hurt", RIG_W, 10, {
    "body": {0: R(), 3: RL((-0.2, 0, 0.08), (0, 0.15, 0)), 10: R()},
    "head": {0: R(), 3: R(-0.35, 0.2, 0), 10: R()},
    "armL": {0: R(), 3: R(-0.5, 0, 0.3), 10: R()},
    "armR": {0: R(), 3: R(-0.5, 0, -0.3), 10: R()},
}, loop=False)
clip("W_summon", RIG_W, 30, {
    "armL": {0: R(), 8: R(-3.0, 0, 0.5), 22: R(-3.05, 0, 0.6), 30: R()},
    "armR": {0: R(), 8: R(0.4, 0, -0.3), 30: R()},
    "body": {0: RL(), 8: RL((-0.15, 0, -0.2), (0, 0, 0.2)), 22: RL((-0.15, 0, -0.25), (0, 0, 0.2)), 30: RL()},
    "head": {0: R(), 8: R(-0.5, -0.3, 0), 22: R(-0.5, -0.3, 0), 30: R()},
}, loop=False)
clip("W_rage", RIG_W, 34, {
    "body": {0: RL(), 6: RL((0.3, 0, 0), (0, 0, -0.5)), 14: RL((-0.35, 0, 0), (0, 0, 0.9)), 26: RL((-0.3, 0, 0), (0, 0, 0.8)), 34: RL()},
    "armL": {0: R(), 6: R(0.8, 0, 0.3), 14: R(-2.4, 0, 1.4), 26: R(-2.5, 0, 1.4), 34: R()},
    "armR": {0: R(), 6: R(0.8, 0, -0.3), 14: R(-2.4, 0, -1.4), 26: R(-2.5, 0, -1.4), 34: R()},
    "head": {0: R(), 6: R(0.4), 14: R(-0.7), 26: R(-0.7), 34: R()},
}, loop=False)
clip("W_death", RIG_W, 40, {
    "body": {0: RL(), 10: RL((-0.3, 0, 0), (0, 0.2, 0.35)), 24: RL((1.35, 0, 0.15), (0, -0.7, 0.55)), 40: RL((1.35, 0, 0.15), (0, -0.7, 0.55))},
    "armL": {0: R(), 10: R(-2.2, 0, 0.7), 24: R(0.9, 0, 1.0), 40: R(0.9, 0, 1.0)},
    "armR": {0: R(), 10: R(-2.2, 0, -0.7), 24: R(0.9, 0, -1.0), 40: R(0.9, 0, -1.0)},
    "head": {0: R(), 10: R(-0.6), 24: R(0.7), 40: R(0.7)},
}, loop=False)
# ---- district elites: the same four clips for each rig (unique names per rig, exporter merges by track name)
for n, rig in MINI.items():
    pre = f"M{n}_"
    clip(pre + "idle", rig, 60, {
        "body": {0: RL(), 30: RL((0.03, 0, 0), (0, 0, 0.08))},
        "head": {0: R(), 20: R(0.05, 0.25, 0), 45: R(-0.05, -0.2, 0)},
        "armL": {0: R(-0.1), 30: R(-0.3, 0, 0.1)},
        "armR": {0: R(-0.1), 30: R(-0.3, 0, -0.1)},
    })
    clip(pre + "walk", rig, 24, {
        "body": {0: RL((0.08, 0, 0.05), (0, 0, 0)), 6: RL((0.08, 0, 0), (0, 0, 0.14)), 12: RL((0.08, 0, -0.05), (0, 0, 0)), 18: RL((0.08, 0, 0), (0, 0, 0.14))},
        "head": {0: R(0.05), 12: R(-0.05)},
        "armL": {0: R(0.6), 12: R(-0.6)},
        "armR": {0: R(-0.6), 12: R(0.6)},
    })
    clip(pre + "attack", rig, 16, {
        "body": {0: RL(), 4: RL((-0.25, 0, 0), (0, 0.3, 0.1)), 8: RL((0.45, 0, 0), (0, -0.5, -0.1)), 16: RL()},
        "head": {0: R(), 4: R(-0.5), 8: R(0.5), 16: R()},
        "armL": {0: R(), 4: R(-1.6, 0, 0.4), 8: R(0.9, 0, 0.2), 16: R()},
        "armR": {0: R(), 4: R(-1.6, 0, -0.4), 8: R(0.9, 0, -0.2), 16: R()},
    }, loop=False)
    clip(pre + "special", rig, 30, {
        "body": {0: RL(), 10: RL((-0.3, 0, 0), (0, 0, 0.5)), 20: RL((-0.3, 0, 0.2), (0, 0, 0.5)), 30: RL()},
        "head": {0: R(), 10: R(-0.7), 20: R(-0.7, 0.3, 0), 30: R()},
        "armL": {0: R(), 10: R(-2.6, 0, 0.7), 20: R(-2.7, 0, 0.9), 30: R()},
        "armR": {0: R(), 10: R(-2.6, 0, -0.7), 20: R(-2.7, 0, -0.9), 30: R()},
    }, loop=False)
    clip(pre + "death", rig, 32, {
        "body": {0: RL(), 8: RL((-0.25, 0, 0), (0, 0.2, 0.3)), 20: RL((1.25, 0, 0.2), (0, -0.5, 0.5)), 32: RL((1.25, 0, 0.2), (0, -0.5, 0.5))},
        "head": {0: R(), 8: R(-0.5), 20: R(0.6), 32: R(0.6)},
        "armL": {0: R(), 8: R(-1.8, 0, 0.6), 20: R(0.8, 0, 0.9), 32: R(0.8, 0, 0.9)},
        "armR": {0: R(), 8: R(-1.8, 0, -0.6), 20: R(0.8, 0, -0.9), 32: R(0.8, 0, -0.9)},
    }, loop=False)
scene.frame_set(0)

# ---------------------------------------------------------------- preview render (kit lineup)
cam_data = bpy.data.cameras.new("Cam")
cam_data.type = "ORTHO"
cam_data.ortho_scale = 70.0
cam = link(bpy.data.objects.new("Cam", cam_data))
cols = min(8, len(KIT)); rows = (len(KIT) + 7) // 8
cx, cy = (cols - 1) * 3.5, (rows - 1) * 4.0
cam.location = (cx + 40, cy - 40, 42)
target = link(bpy.data.objects.new("CamTarget", None))
target.location = (cx, cy, 1.0)
tc = cam.constraints.new("TRACK_TO"); tc.target = target; tc.track_axis = "TRACK_NEGATIVE_Z"; tc.up_axis = "UP_Y"
scene.camera = cam
sun_data = bpy.data.lights.new("Sun", "SUN"); sun_data.energy = 3.0
sun = link(bpy.data.objects.new("Sun", sun_data))
sun.rotation_euler = (math.radians(50), math.radians(-15), math.radians(35))
world = bpy.data.worlds.new("World"); scene.world = world; world.use_nodes = True
bg = world.node_tree.nodes["Background"]; bg.inputs[0].default_value = (0.5, 0.55, 0.65, 1); bg.inputs[1].default_value = 0.8
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = os.path.join(OUT, "preview.png")
for o in bpy.data.objects:
    if o.name.startswith("Snow_"):
        o.hide_render = True
for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "BLENDER_WORKBENCH"):
    try:
        scene.render.engine = engine
        break
    except TypeError:
        continue
if "--no-render" not in argv:
    try:
        bpy.ops.render.render(write_still=True)
        print("preview written:", scene.render.filepath)
    except Exception as e:
        print("render failed:", e)

# ---------------------------------------------------------------- export GLB (kit empties + all descendants)
bpy.ops.object.select_all(action="DESELECT")
for o in bpy.data.objects:
    if o.type in ("MESH", "EMPTY") and o is not target:
        o.select_set(True)
glb = os.path.join(OUT, "site", "assets", "kit.glb")
bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_materials="EXPORT", export_animations=True, export_animation_mode="NLA_TRACKS",
                          export_force_sampling=True, export_lights=False, export_cameras=False)
meshes = sum(1 for o in bpy.data.objects if o.type == "MESH")
tris = sum(len(o.data.polygons) for o in bpy.data.objects if o.type == "MESH")
print(f"exported {glb}: {len(KIT)} kit items, {meshes} meshes, ~{tris} polys, {os.path.getsize(glb)/1e6:.2f} MB")
