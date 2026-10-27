import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentStore } from '../attachments.ts';
import { resolveImages } from './images.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-images-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// a 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('resolveImages', () => {
  it('known refs get their media type and their bytes; an unknown one is reported and dropped, the others still go', () => {
    const store = new AttachmentStore({ dir });
    const id = store.put(PNG, 'image/png');
    const errors: string[] = [];
    const r = resolveImages(store, [{ id: 'nope', mediaType: 'image/png', label: 'a' }, { id, mediaType: 'image/jpeg', label: 'b' }], (e) => errors.push((e as Error).message));
    expect(errors).toEqual(['unknown attachment nope']);
    expect(r.refs).toEqual([{ id, label: 'b', mediaType: 'image/png' }]);
    expect(r.payload).toEqual([{ mediaType: 'image/png', data: PNG.toString('base64'), label: 'b' }]);
  });

  it('no images: nothing', () => {
    expect(resolveImages(new AttachmentStore({ dir }), undefined, () => {})).toEqual({ refs: [], payload: [] });
  });
});
