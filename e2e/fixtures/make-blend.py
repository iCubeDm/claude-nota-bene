# Makes models/scene.blend (committed): an empty scene with one cube and one Principled material.
# Run from the repo root (see make-blend.mjs): Blender -b --factory-startup --python e2e/fixtures/make-blend.py -- <out.blend>
import sys

import bpy

out = sys.argv[sys.argv.index('--') + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1.0)
cube = bpy.context.active_object
cube.name = 'Crate'
mat = bpy.data.materials.new('Paint')
mat.use_nodes = True
bsdf = mat.node_tree.nodes['Principled BSDF']
bsdf.inputs['Base Color'].default_value = (0.9, 0.25, 0.1, 1.0)
bsdf.inputs['Metallic'].default_value = 0.2
bsdf.inputs['Roughness'].default_value = 0.5
cube.data.materials.append(mat)
bpy.ops.wm.save_as_mainfile(filepath=out, compress=True)
