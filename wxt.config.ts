import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'LLM Translate',
    permissions: ['storage'],
    optional_host_permissions: ['*://*/*'],
  },
});
