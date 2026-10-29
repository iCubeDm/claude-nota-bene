import { isMediaAnchor, type Comment, type MediaAnchor } from '@nota-bene/shared';
import { prepareImage, uploadImage } from '../attachments/image.ts';
import { drawShapes } from '../media/markup/render.ts';
import { drawBadges } from '../media/markup/badges.ts';

/** Comments of one batch that mark the same picture: same file, ref, time, version and size. `idx` are 0-based batch positions. */
export type FrameGroup = { key: string; idx: number[] };

const frameKey = (a: MediaAnchor): string =>
  JSON.stringify([a.source.path, a.source.ref ?? null, a.time ?? null, a.version ?? null, a.width, a.height]);

/** Groups of >= 2 pending media comments on one source frame (each with a stored frame image). `key` = the comment ids, so a changed batch never matches a stale composite. */
export function frameGroups(pending: Comment[]): FrameGroup[] {
  const by = new Map<string, number[]>();
  pending.forEach((c, i) => {
    if (!isMediaAnchor(c.anchor) || !c.images?.[0]) return;
    const k = frameKey(c.anchor);
    by.set(k, [...(by.get(k) ?? []), i]);
  });
  return [...by.values()].filter((idx) => idx.length > 1).map((idx) => ({ key: idx.map((i) => pending[i].id).join(','), idx }));
}

/**
 * One composite per group, uploaded: the first comment's attached frame (its own shapes already drawn) plus the other
 * comments' shapes, then a numbered badge per comment (its batch number). Built from the already downscaled attachments,
 * so it needs no reload or video seek and the badges are sized for the final pixels. Returns group key → attachment id.
 * Rejects on any failure; the caller sends nothing then.
 */
export async function buildComposites(pending: Comment[], groups: FrameGroup[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const g of groups) {
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
      for (const m of members.slice(1)) drawShapes(ctx, m.a.shapes, c.width, c.height);
      drawBadges(ctx, members.map((m) => ({ n: m.n, shapes: m.a.shapes })), c.width, c.height);
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
      if (!blob) throw new Error('could not encode the image');
      out.set(g.key, (await uploadImage(await prepareImage(blob))).id);
    } finally {
      bmp.close();
    }
  }
  return out;
}
