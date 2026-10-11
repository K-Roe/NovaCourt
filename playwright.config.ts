import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  use: { headless: false },
  reporter: 'list',
  outputDir: 'test-results'
})
