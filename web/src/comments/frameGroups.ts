import { isMediaAnchor, type Comment, type MediaAnchor } from '@nota-bene/shared';
import { prepareImage, uploadImage } from '../attachments/image.ts';
import { drawShapes, strokeWidth } from '../media/markup/render.ts';
import { drawBadges } from '../media/markup/badges.ts';

/** Comments of one batch that mark the same picture: same file, ref, time, version and size. `idx` are 0-based batch positions. */
export type FrameGroup = { key: string; idx: number[] };

const frameKey = (a: MediaAnchor): string =>
  JSON.stringify([a.source.path, a.source.ref ?? null, a.time ?? null, a.version, a.width, a.height]);

/**
 * Groups of >= 2 pending media comments on one source frame (each with a stored frame image). A comment without a known
 * `version` never groups (two different contents of one file could look alike). `key` = batch position + comment id of
 * every member, so a changed or renumbered batch never matches a stale composite (its badges carry those numbers).
 */
export function frameGroups(pending: Comment[]): FrameGroup[] {
  const by = new Map<string, number[]>();
  pending.forEach((c, i) => {
    if (!isMediaAnchor(c.anchor) || c.anchor.version === undefined || !c.images?.[0]) return;
    const k = frameKey(c.anchor);
    by.set(k, [...(by.get(k) ?? []), i]);
  });
  return [...by.values()].filter((idx) => idx.length > 1).map((idx) => ({ key: idx.map((i) => `${i + 1}:${pending[i].id}`).join(','), idx }));
}

/** One group's composite, uploaded: the first comment's attached frame (its shapes drawn) plus the others' shapes, then a numbered badge per comment. */
async function composite(pending: Comment[], g: FrameGroup): Promise<string> {
  const members = g.idx.map((i) => ({ n: i + 1, a: pending[i].anchor as MediaAnchor }));
  const r = await fetch(`/attach/${pending[g.idx[0]].images![0]}`);
  if (!r.ok) throw new Error(`attach ${r.status}`);
  const bmp = await createImageBitmap(await r.blob());
  try {
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no 2d canvas');
    ctx.drawImage(bmp, 0, 0);
    // the first comment's shapes were drawn at the natural size and shrunk with the upload: the others get the same stroke width
    const a0 = members[0].a, nat = a0.scale ?? 1;
    const lw = Math.max(1, strokeWidth(Math.round(a0.width * nat), Math.round(a0.height * nat)) * (c.width / (a0.width * nat)));
    for (const m of members.slice(1)) drawShapes(ctx, m.a.shapes, c.width, c.height, lw);
    drawBadges(ctx, members.map((m) => ({ n: m.n, shapes: m.a.shapes })), c.width, c.height);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
    if (!blob) throw new Error('could not encode the image');
    return (await uploadImage(await prepareImage(blob))).id;
  } finally {
    bmp.close();
  }
}

/**
 * One composite per group, built from the already downscaled attachments (no reload or video seek; the badges are sized for
 * the final pixels). Returns group key → attachment id. Never rejects: a group that fails is left out (warned once) and its
 * comments go with their own frames.
 */
export async function buildComposites(pending: Comment[], groups: FrameGroup[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let warned = false;
  for (const g of groups) {
    try {
      out.set(g.key, await composite(pending, g));
    } catch (e) {
      if (!warned) console.warn('composite image failed, sending the frames separately:', e);
      warned = true;
    }
  }
  return out;
}
