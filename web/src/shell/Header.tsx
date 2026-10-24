export function Header() {
  return (
    <header className="relative z-[6] flex h-12 flex-none items-center gap-3 border-b border-border-soft bg-chrome px-4 text-xs text-muted-foreground backdrop-blur-[24px]">
      <img id="logo" src="/icon.svg" alt="Nota Bene" className="-mr-1 size-6" />
      <b id="proj" className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">Nota Bene</b>
      <span id="root-path" className="font-mono text-[11px] opacity-70">-</span>
      <span className="flex-1" />
      <span id="conn" className="text-warn">connecting</span>
      <span id="session" className="font-mono text-[11px]">-</span>
    </header>
  );
}
