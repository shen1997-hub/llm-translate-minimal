import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1, // stub server 的 fail/delay 是全局状态，串行跑避免互相干扰
  globalSetup: './e2e/global-setup.ts',
});
