import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { themePreloadPlugin } from './lib/build/theme-preload-plugin';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  webExt: {
    disabled: true,
  },
  manifest: {
    default_locale: 'en',
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    permissions: [
      'sidePanel',
      'storage',
      'activeTab',
      'tabs',
      'bookmarks',
      'history',
      'scripting',
      'webNavigation',
      'webRequest',
      'declarativeNetRequest',
      'cookies',
      'downloads',
      'debugger',
      'tabGroups',
      'contextMenus',
      'notifications',
      // MCP authorization: the consent flow needs a browser-owned redirect URI
      // (`chrome.identity.getRedirectURL()`) and the window that intercepts it.
      'identity',
    ],
    host_permissions: ['<all_urls>'],
    content_security_policy: {
      // QuickJS needs WebAssembly compilation for the shell's `node` command.
      // This permits wasm only; it does not allow `eval` or `new Function` in
      // extension pages.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
      sandbox:
        "sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http: blob: data:; child-src 'self' blob:;",
    },
    sandbox: {
      pages: ['sandbox.html'],
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
    action: {
      default_title: '__MSG_actionTitle__',
    },
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
  },
  vite: () => ({
    plugins: [tailwindcss(), themePreloadPlugin()],
    build: {
      // Chrome 拒绝复用跨 script world 的 chrome-extension:// 预加载资源
      // (Resource::CanReuse -> kCrossWorldExtensionResourceMismatch)，导致
      // 扩展页面每次加载都刷出 "cross-world extension resource mismatch" 与
      // "preloaded but not used" 警告。扩展资源是本地读取，modulepreload
      // 省不下网络 RTT，且各入口的 chunk 均为直接静态依赖，故直接关闭。
      modulePreload: false,
      // 侧边栏/设置页本地加载 CodeMirror、Shiki 等大依赖；单个入口超过默认
      // 500 kB 属预期，不应在每次构建时输出“错误感”的警告。
      chunkSizeWarningLimit: 1200,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname),
        // just-bash's browser bundle statically imports node:zlib. The shim
        // backs gzip/gunzip with fflate, which works in the extension.
        'node:zlib': path.resolve(__dirname, 'lib/shell/shims/zlib.ts'),
      },
    },
  }),
});
