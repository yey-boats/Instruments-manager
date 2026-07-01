// Playwright config for editor authoring tests — standalone, uses chromium only.
// Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /test-editor-authoring\.pw\.js/,
  timeout: 40000,
  use: {
    headless: true,
    viewport: { width: 1280, height: 860 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  reporter: [["list"]],
  workers: 1,
});
