import { getLang, setLang, useT } from '@/i18n/index.ts';

export function Header() {
  const t = useT();
  const other = getLang() === 'ru' ? 'en' : 'ru';
  return (
    <header className="relative z-[6] flex h-12 flex-none items-center gap-3 border-b border-border-soft bg-chrome px-4 text-xs text-muted-foreground backdrop-blur-[24px]">
      <img id="logo" src="/icon.svg" alt="Nota Bene" className="-mr-1 size-6" />
      <b id="proj" className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">Nota Bene</b>
      <span id="root-path" className="font-mono text-[11px] opacity-70">-</span>
      <span className="flex-1" />
      <span id="conn" className="text-warn">{t('connecting')}</span>
      <span id="session" className="font-mono text-[11px]">-</span>
      <button
        type="button"
        id="langBtn"
        title={t('langTip')}
        onClick={() => setLang(other)}
        className="cursor-pointer rounded-md border border-border-soft px-2 py-0.5 text-[11px] font-medium hover:text-foreground"
      >
        {other.toUpperCase()}
      </button>
    </header>
  );
}
