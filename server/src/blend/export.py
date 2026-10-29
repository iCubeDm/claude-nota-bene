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
# every node group of the file, nested ones included (they are all in bpy.data.node_groups)
bad += ['%s: %s' % (g.name, n.bl_idname) for g in bpy.data.node_groups for n in g.nodes if n.bl_idname.startswith('GeometryNodeImport')]
if bad:
    print('NB-REFUSED ' + json.dumps([b[:300] for b in bad[:10]]))
    sys.exit(3)

bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_apply=True)
