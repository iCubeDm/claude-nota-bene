import { useT } from '@/i18n/index.ts';
import { selectConn, useAppSelector } from '@/store/store.ts';

/**
 * The server turned this page away for lack of a login (the access token, net/auth.ts). A reconnect cannot fix it, so there
 * is no retry: the window has to be opened again through `nota-bene` or `/nb`, whose address carries the token.
 */
export function LoginRequired() {
  const t = useT();
  const conn = useAppSelector(selectConn);
  if (conn !== 'unauthorized') return null;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="login-required-title"
      data-testid="login-required"
      className="fixed inset-0 z-[100] grid place-items-center bg-background/95"
    >
      <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center">
        <h1 id="login-required-title" className="text-lg font-semibold text-foreground">{t('loginRequiredTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('loginRequiredBody')}</p>
      </div>
    </div>
  );
}
