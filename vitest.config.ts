import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Cases spawn real MCP server processes over stdio; keep files sequential
    // like the previous jest --runInBand setup to avoid process races.
    fileParallelism: false,
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/**'],
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov'],
    },
  },
})
