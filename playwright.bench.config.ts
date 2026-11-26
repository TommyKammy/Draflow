import { defineConfig } from '@playwright/test';
import config from './playwright.config.js';

export default defineConfig({
  ...config,
  testDir: './apps/demo/bench',
  workers: 1,
  use: { ...config.use, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
});
