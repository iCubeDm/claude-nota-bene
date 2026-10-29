import { useEffect, useState, type ComponentType } from 'react';
import { t } from '@/i18n/index.ts';

type Props = { path: string; src: string; tabId: string; active: boolean; reloadKey: number };

// ModelBody (with its strings' logic, the size cap, the reader) is its own chunk, so the main one pays for none of it;
// it in turn loads the three chunk (@/model/viewer.ts) when the first model is fetched
let bodyP: Promise<ComponentType<Props>> | undefined;
function loadBody(): Promise<ComponentType<Props>> {
  bodyP ??= import('./ModelBody.tsx').then((m) => m.ModelBody);
  bodyP.catch(() => { bodyP = undefined; }); // a failed chunk load must not stick: the next model tab tries again
  return bodyP;
}

/** A model tab's pane. Nothing is loaded until the tab is shown for the first time. */
export function ModelPane(p: Props) {
  const [Body, setBody] = useState<ComponentType<Props> | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!p.active || Body) return;
    let dead = false;
    loadBody().then((c) => !dead && setBody(() => c), (e: unknown) => !dead && setFailed(e instanceof Error ? e.message : String(e)));
    return () => { dead = true; };
  }, [p.active, Body]);
  if (Body) return <Body {...p} />;
  return (
    <div data-pane={p.tabId} hidden={!p.active} className="grid-pane relative min-h-0 flex-1 overflow-hidden">
      {failed !== null && <p role="alert" className="p-4 text-sm text-muted-foreground">{t('modelFailed', failed)}</p>}
    </div>
  );
}
