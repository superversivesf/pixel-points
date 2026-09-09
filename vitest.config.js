import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    // Socket tests bind real ports and use real timers; run files serially to
    // avoid port/timing interference between test files.
    fileParallelism: false,
  },
});