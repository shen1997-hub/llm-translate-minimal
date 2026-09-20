import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'LLM Translate',
    permissions: ['storage', 'activeTab'],
    // 静态 host 权限：安装时一次授予，SW 跨域 fetch 任意 API 域名不再需要运行时授权点击。
    // （content script 本就注入 <all_urls>，安装警告不新增暴露面）
    host_permissions: ['*://*/*'],
  },
});
