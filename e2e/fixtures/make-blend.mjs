// Regenerates models/scene.blend (committed) with the real Blender: node e2e/fixtures/make-blend.mjs
// Blender is found like the server does: NOTA_BENE_BLENDER, then PATH, then the macOS app.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findBlender } from '../../server/src/blend.ts';

const bin = findBlender();
if (!bin) throw new Error('no Blender found (set NOTA_BENE_BLENDER)');
const out = fileURLToPath(new URL('./project/models/scene.blend', import.meta.url));
execFileSync(bin, ['-b', '--factory-startup', '--python', fileURLToPath(new URL('./make-blend.py', import.meta.url)), '--', out], { stdio: 'inherit' });
