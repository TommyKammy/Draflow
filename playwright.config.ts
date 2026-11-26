import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4176';
export default defineConfig({
  testDir: './apps/demo/test',
  use: { baseURL, browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm --filter @draflow/demo preview --host 127.0.0.1 --port 4176 --strictPort',
    url: baseURL,
  },
});
