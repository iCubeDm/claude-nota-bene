# Run by Blender (see ../blend.ts): converts the .blend that Blender has already opened to a GLB.
# The output path comes from argv after `--`; nothing is ever interpolated into Python source.
import sys

import bpy

argv = sys.argv
out = argv[argv.index('--') + 1] if '--' in argv else None
if not out:
    raise SystemExit('export.py: output path missing')

bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_apply=True)
