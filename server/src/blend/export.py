# Run by Blender (see ../blend.ts): converts the .blend that Blender has already opened to a GLB.
# argv after `--`: <out.glb> <allowed base dir>...   Nothing is ever interpolated into Python source.
#
# Refuses (exit 3, one `NB-REFUSED <json list>` line for the server) a file that would pull content from outside the
# allowed dirs into the GLB: any external file it references (images, libraries, fonts, sounds, movie clips, volumes,
# cache files, sequencer strips... whatever bpy.utils.blend_paths lists, packed data excluded), and any Geometry Nodes
# import node (Import Text / CSV / OBJ / PLY / STL / VDB read a path that may be computed, so blend_paths cannot see it).
import json
import os
import sys

import bpy

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
if not args:
    raise SystemExit('export.py: output path missing')
out, *bases = args
# Blender's own install dir (default assets, brushes) is always readable; real paths so symlinks cannot widen a base
bases = [os.path.realpath(b) for b in bases] + [os.path.realpath(bpy.utils.resource_path('LOCAL'))]


def inside(p):
    r = os.path.realpath(p)
    return any(r == b or r.startswith(b + os.sep) for b in bases)


bad = [p for p in bpy.utils.blend_paths(absolute=True, packed=False) if not inside(p)]


def tile_files(img):
    # a tiled image lists one pattern (<UDIM> / <UVTILE>); each tile is its own file, and may be a symlink
    pat = bpy.path.abspath(img.filepath_raw or img.filepath)
    for t in img.tiles:
        n = t.number
        yield pat.replace('<UDIM>', str(n)).replace('<UVTILE>', 'u%d_v%d' % ((n - 1001) % 10 + 1, (n - 1001) // 10 + 1))


bad += [f for img in bpy.data.images if img.source == 'TILED' and not img.packed_file and not img.packed_files
        for f in tile_files(img) if not inside(f)]


def point_caches(ob):
    for m in ob.modifiers:
        pc = getattr(m, 'point_cache', None)
        if pc is not None:
            yield m.name, pc
    for ps in ob.particle_systems:
        yield ps.name, ps.point_cache
    if ob.soft_body is not None:
        yield 'softbody', ob.soft_body.point_cache


for ob in bpy.data.objects:
    for m in ob.modifiers:
        if m.type != 'NODES':
            continue
        # A bake on disk reads blob files by names from its own meta files, "../" included: any file can be read.
        # Packed bakes live inside the .blend and stay allowed.
        for b in m.bakes:
            if (b.bake_target if b.bake_target != 'INHERIT' else m.bake_target) == 'DISK':
                bad.append('%s: %s disk bake' % (ob.name, m.name))
                break
    for name, pc in point_caches(ob):
        if pc.use_external:
            bad.append('%s: %s external point cache' % (ob.name, name))
for sc in bpy.data.scenes:
    rw = sc.rigidbody_world
    if rw is not None and rw.point_cache is not None and rw.point_cache.use_external:
        bad.append('%s: external point cache' % sc.name)
# every node group of the file, nested ones included (they are all in bpy.data.node_groups)
bad += ['%s: %s' % (g.name, n.bl_idname) for g in bpy.data.node_groups for n in g.nodes if n.bl_idname.startswith('GeometryNodeImport')]
if bad and not os.environ.get('NB_TEST_SKIP_STATIC_CHECK'):
    print('NB-REFUSED ' + json.dumps([b[:300] for b in bad[:10]]))
    sys.exit(3)

bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_apply=True)
