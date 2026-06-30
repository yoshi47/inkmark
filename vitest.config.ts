import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/rfm/**/*.test.ts', 'src/server/**/*.test.ts', 'src/cli/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'web',
          environment: 'jsdom',
          setupFiles: ['@testing-library/jest-dom/vitest'],
          include: ['src/web/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
