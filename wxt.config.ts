import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'LLM Translate',
    permissions: ['storage', 'activeTab'],
    optional_host_permissions: ['*://*/*'],
  },
});
