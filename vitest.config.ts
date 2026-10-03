import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 30000,
    fileParallelism: false,
  },
});
