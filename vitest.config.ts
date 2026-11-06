import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['test/setup-roster.ts'],
    typecheck: {
      enabled: true,
      include: ['test/**/*.test-d.ts'],
    },
  },
})
