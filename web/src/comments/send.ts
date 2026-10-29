import { generatedImages, isMediaAnchor, type AnchorSource, type Comment, type ImageRef } from '@nota-bene/shared';
import { mediaTypeOf } from '../attachments/image.ts';
import { getLang, t, tIn } from '../i18n/index.ts';
import { selectReplyLabel, sendMessage, type AppThunk, type RootState } from '../store/store.ts';
import { composeBatch } from './compose.ts';
import { instructionOf, labelOf } from './labels.ts';
import { draftSent, removeImage, selectBuilding, selectDraft, selectImages, selectUploading, setBuilding, setDraft, type ImageEntry } from '../composer/slice.ts';
import { markSending, selectComments, selectPending, unmarkSending } from './slice.ts';
import { selectFileVersion } from '../files/slice.ts';
import { cameraLine } from '../model/pose.ts';
import { mediaTime } from '../media/markup/geometry.ts';
import { activate } from '../tabs/slice.ts';
import { toast } from '../shell/toast.ts';
import { agentName } from '../subagent/slice.ts';
import { buildComposites, frameGroups, type FrameGroup } from './frameGroups.ts';

/** 'building': a combined image is being made and uploaded; the send finishes by itself (the button is disabled meanwhile). 'changed': the comments or the session changed during that wait, nothing was sent. */
export type SendResult = 'empty' | 'sent' | 'offline' | 'switching' | 'building' | 'changed';

/** A file source as the batch and the card name it: `path`, or `path @ ref` for another branch or worktree (M3-16). */
export const whereOfFile = (src: Extract<AnchorSource, { kind: 'file' }>): string => (src.ref ? `${src.path} @ ${src.ref}` : src.path);

/** The images of a comment that go out on their own: a media comment's frame (images[0]; its layer.png stays on disk) and every pasted image. */
const ownImages = (c: Comment): string[] => {
  const all = c.images ?? [], gen = generatedImages(c);
  return [...all.slice(0, Math.min(1, gen)), ...all.slice(gen)];
};
/** Pasted images only (a grouped media comment sends the shared composite instead of its frame). */
const pastedImages = (c: Comment): string[] => (c.images ?? []).slice(generatedImages(c));

/** Where a comment's fragment lives, for the batch line: the reply label, "my message", or the file. */
export function whereOf(c: Comment, st?: Parameters<typeof selectReplyLabel>[0]): string {
  const src = c.anchor.source;
  const a = c.anchor;
  if (isMediaAnchor(a)) return `${whereOfFile(a.source)}${a.time !== undefined ? ` @ ${mediaTime(a.time)}` : ''} · ${a.width}×${a.height}${a.camera ? ` · ${cameraLine(a.camera, getLang())}` : ''}`;
  if (src.kind === 'file') return whereOfFile(src);
  // the batch text names a reply plainly: its number is the index in the CURRENT feed (restarts after a compaction, shifts when earlier history is shown); the quote is the locator
  // a subagent's reply or action is named with the subagent (no numbers); one the loaded conversation does not hold still is not "chat"
  if (src.agent) return (st && selectReplyLabel(st, src.id, true, src.agent)) ?? t('srcAgentReply', st ? agentName(st, src.agent) : '');
  return (st && selectReplyLabel(st, src.id, true)) ?? t('srcChat');
}

/** What one click on Send takes: the session, the draft (text and images) and the pending comments with a fingerprint each. */
type Snapshot = { sid: string | null | undefined; draft: string; body: string; own: ImageEntry[]; pending: Comment[]; prints: string[] };
// keys sorted: the client and the server's echo build the same anchor with its keys in a different order
const stable = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(stable)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]))
  : v;
const printOf = (c: Comment): string => JSON.stringify(stable([c.text, c.label, c.anchor, c.images, c.genImages]));
const snapshotOf = (st: RootState): Snapshot => {
  const pending = selectPending(st), draft = selectDraft(st);
  return { sid: st.feed.session?.id, draft, body: draft.trim(), own: selectImages(st), pending, prints: pending.map(printOf) };
};
/** Still the same send? Same session, and every snapshot comment is still pending and unchanged. */
const unchanged = (st: RootState, snap: Snapshot): boolean =>
  st.feed.session?.id === snap.sid
  && snap.pending.every((c, i) => {
    const now = selectComments(st).find((x) => x.id === c.id);
    return now?.status === 'pending' && printOf(now) === snap.prints[i];
  });

/**
 * Sends exactly the snapshot (its ids are already in `sendingIds`; any result but 'sent' releases them). Pending → sent
 * happens only via the server echo. On success only what was snapshotted leaves the composer: the draft text (a tail typed
 * since stays) and the snapshotted images; comment images stay on their comments. Images are numbered across the whole
 * message: the composer's first, then each comment's in order. Media comments on one source frame share one composite image
 * (`composites`: group key → attachment id; a group without one falls back to each comment's own frame). A send switches to the chat tab.
 */
const sendNow = (snap: Snapshot, composites: Map<string, string>, force: boolean): AppThunk<SendResult> => (d, getState) => {
  const st = getState();
  const { pending, body, own } = snap;
  const ids = pending.map((c) => c.id);
  const fail = (r: SendResult): SendResult => (d(unmarkSending(ids)), r);
  if (st.controls.switching) return fail('switching'); // the server refuses sends mid-switch; the draft and the comments stay for the new session
  if (!unchanged(st, snap)) return fail('changed');
  const lang = getLang();
  const images: ImageRef[] = own.map((im, k) => ({ ...im, label: tIn(lang, 'imgLabel', k + 1) }));
  const push = (id: string, label: (k: number) => string): number => (images.push({ id, mediaType: mediaTypeOf(id), label: label(images.length + 1) }), images.length);
  const shared: ({ k: number; cs: number[] } | undefined)[] = [];
  const groupOf = new Map<number, FrameGroup>();
  for (const g of frameGroups(pending)) if (composites.has(g.key)) for (const i of g.idx) groupOf.set(i, g);
  const sharedK = new Map<string, number>(); // group key → its image number, once pushed
  const refs = pending.map((c, i) => {
    const g = groupOf.get(i);
    const mine = (list: string[]) => list.map((id) => push(id, (k) => tIn(lang, 'imgLabelC', k, i + 1)));
    if (!g) return mine(ownImages(c));
    const cs = g.idx.map((j) => j + 1);
    if (!sharedK.has(g.key)) sharedK.set(g.key, push(composites.get(g.key)!, (k) => tIn(lang, 'imgLabelG', k, cs)));
    shared[i] = { k: sharedK.get(g.key)!, cs };
    return [shared[i]!.k, ...mine(pastedImages(c))];
  });
  const text = composeBatch(
    body, pending, lang, (c) => labelOf(c, lang),
    (c) => whereOf(c, st),
    instructionOf, refs,
    // "changed": only when the current version is known (a tab has it loaded) and differs from the one drawn on
    (c) => {
      const a = c.anchor;
      if (!isMediaAnchor(a) || a.version === undefined) return false;
      const cur = selectFileVersion(st, a.source.path, a.source.ref);
      return cur !== undefined && cur !== a.version;
    },
    shared,
  );
  const id = crypto.randomUUID();
  if (!d(sendMessage(text, force, ids, images, id))) return fail('offline');
  d(draftSent({ id, text: body, images: own, commentIds: ids })); // until the echo: a refusal puts it back
  const cur = selectDraft(getState());
  d(setDraft(snap.draft && cur.startsWith(snap.draft) ? cur.slice(snap.draft.length).trimStart() : cur));
  for (const im of own) d(removeImage(im.id));
  d(activate('chat')); // sent from a file tab: the reply arrives in the chat (prototype parity)
  return 'sent';
};

/** How long building the shared images may take before the send goes on with each comment's own frame. */
export const COMPOSITE_MS = 15_000;

/** After the async part: anything but 'sent' is told to the user, never silent. */
const tell = (r: SendResult): void => {
  if (r === 'offline') toast(t('offline'), '');
  else if (r === 'switching') toast(t('switching'), '');
  else if (r === 'changed') toast(t('changedWhileSending'), '');
};

/**
 * Entry point: SNAPSHOT AT THE CLICK. The draft, its images and the pending comments are taken now and their ids marked as
 * sending, so nothing sent later (and no second click) can touch them; whatever is added meanwhile stays out of this send.
 * Comments sharing a source frame (with a live connection) get their composite images built from the snapshot first: the
 * send buttons are off for the duration ('building') and a second call is 'empty'. Then `sendNow` sends the snapshot if the
 * session and the comments are unchanged, else nothing (released, the user is told). An upload still running at the click blocks it.
 */
export const sendBatch = (force: boolean): AppThunk<SendResult> => (d, getState) => {
  const st = getState();
  if (st.controls.switching) return 'switching';
  const snap = snapshotOf(st);
  if ((!snap.body && !snap.pending.length && !snap.own.length) || selectUploading(st) || selectBuilding(st)) return 'empty';
  d(markSending(snap.pending.map((c) => c.id)));
  const groups = frameGroups(snap.pending);
  if (!groups.length || st.conn.state !== 'open') return d(sendNow(snap, new Map(), force));
  d(setBuilding(true));
  // a stalled /attach must not keep Send off for good: past COMPOSITE_MS the groups fall back to their own frames
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('composite timeout')), COMPOSITE_MS); });
  void Promise.race([buildComposites(snap.pending, groups), late])
    .catch(() => new Map<string, string>())
    .then((c) => {
      clearTimeout(timer);
      d(setBuilding(false));
      try {
        tell(d(sendNow(snap, c, force)));
      } catch (e) {
        d(unmarkSending(snap.pending.map((x) => x.id))); // the comments go back to pending, nothing lost
        console.error('send after the composite failed', e);
        toast(t('sendFailedRetry'), '');
      }
    });
  return 'building';
};
