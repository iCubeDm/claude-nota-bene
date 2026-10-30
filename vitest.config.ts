import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'scripts/**/*.test.ts'],
        },
      },
      {
        // the launcher and /nb tests spawn real servers on the shared ports 4791-4795: one file at a time
        test: {
          name: 'launcher',
          environment: 'node',
          include: ['bin/**/*.test.ts', 'plugin/**/*.test.ts'],
          fileParallelism: false,
        },
      },
      {
        extends: './web/vite.config.ts',
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['web/src/**/*.test.{ts,tsx}'],
          setupFiles: ['./web/src/test-setup.ts'],
        },
      },
    ],
  },
});
