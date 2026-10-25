import { Composer } from '@/composer/Composer.tsx';
import { TasksLine } from './TasksLine.tsx';
import { Meters } from '@/stats/Meters.tsx';

export function Footer() {
  return (
    <footer className="flex-none border-t border-border-soft bg-chrome backdrop-blur-[24px]">
      <div className="mx-auto max-w-[860px] px-6">
        <Meters />
        <TasksLine />
        <Composer />
      </div>
    </footer>
  );
}
