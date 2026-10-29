import type { CameraPose, ModelViewer } from './api.ts';

/**
 * The live viewer of each model tab, by tab id. This is how step B (margin comments on a model view) reaches a tab's
 * camera pose and snapshot from outside the tab's component, as the media controller does for players.
 */
const viewers = new Map<string, ModelViewer>();

export const registerModelViewer = (tabId: string, v: ModelViewer): void => void viewers.set(tabId, v);
export const unregisterModelViewer = (tabId: string, v: ModelViewer): void => {
  if (viewers.get(tabId) !== v) return;
  viewers.delete(tabId);
  publishViewPose(tabId, null);
};
export const getModelViewer = (tabId: string): ModelViewer | undefined => viewers.get(tabId);

// The live camera of each model tab, for the parts of the UI that follow it (which comments' marks are at this view).
const poses = new Map<string, CameraPose>();
const watchers = new Map<string, Set<() => void>>();

/** Called by the tab for every camera change (null: the viewer is gone). */
export function publishViewPose(tabId: string, pose: CameraPose | null): void {
  if (pose) poses.set(tabId, pose); else poses.delete(tabId);
  for (const f of watchers.get(tabId) ?? []) f();
}
export const getViewPose = (tabId: string): CameraPose | undefined => poses.get(tabId);
export function subscribeViewPose(tabId: string, f: () => void): () => void {
  let set = watchers.get(tabId);
  if (!set) watchers.set(tabId, (set = new Set()));
  set.add(f);
  return () => void (set.delete(f), set.size || watchers.delete(tabId));
}
