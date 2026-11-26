import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['draflow-source'],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
