import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip.tsx';

afterEach(cleanup);

it('the tooltip looks like the prototype #tip: popover bg, 1px border, radius 8, 11.5px, muted text', () => {
  render(
    <TooltipProvider>
      <Tooltip defaultOpen>
        <TooltipTrigger>x</TooltipTrigger>
        <TooltipContent>hint</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );
  const c = document.querySelector('[data-slot="tooltip-content"]')!;
  expect(c).toHaveTextContent('hint');
  for (const k of ['bg-popover', 'border', 'border-border', 'rounded-lg', 'text-[11.5px]', 'text-muted-foreground']) expect(c.className).toContain(k);
  expect(c.className).not.toContain('bg-foreground');
  expect(screen.getAllByText('hint').length).toBeGreaterThan(0);
});
