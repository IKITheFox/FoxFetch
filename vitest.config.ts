import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/modules/**/*.ts', 'src/shared/**/*.ts'],
      thresholds: {
        statements: 50,
        branches: 40,
        functions: 50,
        lines: 55,
      },
    },
  },
});
