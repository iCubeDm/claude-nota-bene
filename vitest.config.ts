import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['shared/**/*.test.ts', 'server/**/*.test.ts'],
        },
      },
    ],
  },
});
