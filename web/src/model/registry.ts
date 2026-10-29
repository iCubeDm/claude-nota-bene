import type { ModelViewer } from './api.ts';

/**
 * The live viewer of each model tab, by tab id. This is how step B (margin comments on a model view) reaches a tab's
 * camera pose and snapshot from outside the tab's component, as the media controller does for players.
 */
const viewers = new Map<string, ModelViewer>();

export const registerModelViewer = (tabId: string, v: ModelViewer): void => void viewers.set(tabId, v);
export const unregisterModelViewer = (tabId: string, v: ModelViewer): void => void (viewers.get(tabId) === v && viewers.delete(tabId));
export const getModelViewer = (tabId: string): ModelViewer | undefined => viewers.get(tabId);
