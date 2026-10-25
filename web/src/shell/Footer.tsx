import { Composer } from '@/composer/Composer.tsx';

export function Footer() {
  return (
    <footer className="flex-none border-t border-border-soft bg-chrome backdrop-blur-[24px]">
      <div className="mx-auto max-w-[860px] px-6">
        <Composer />
      </div>
    </footer>
  );
}
