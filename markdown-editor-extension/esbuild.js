// esbuild 构建脚本：分别打包「扩展宿主」与「Webview React 应用」
// 用法：
//   node esbuild.js       -> 开发模式（sourcemap）
//   node esbuild.js --production -> 压缩产物
//   node esbuild.js --watch      -> 监听增量构建
const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');

/** 扩展宿主：Node CJS，vscode 作为 external */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: !isProduction,
  minify: isProduction,
};

/** Webview：浏览器 IIFE，打包 React + remons-markdown-editor，同时产出配套 CSS */
const webviewConfig = {
  entryPoints: ['src/webview/main.tsx'],
  bundle: true,
  outfile: 'dist/webview/main.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: !isProduction,
  minify: isProduction,
  jsx: 'automatic',
  // katex.min.css 通过 url() 引用字体，需由 esbuild 拷贝到产物目录
  loader: {
    '.woff': 'file',
    '.woff2': 'file',
    '.ttf': 'file',
  },
  assetNames: 'fonts/[name]-[hash]',
  // antd / 组件库依赖浏览器全局，定义 process 兼容部分 CJS 依赖
  define: {
    'process.env.NODE_ENV': isProduction ? '"production"' : '"development"',
    global: 'globalThis',
  },
};

async function run() {
  if (isWatch) {
    const ctxExt = await esbuild.context(extensionConfig);
    const ctxWeb = await esbuild.context(webviewConfig);
    await Promise.all([ctxExt.watch(), ctxWeb.watch()]);
    console.log('[esbuild] watching...');
    return;
  }
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(webviewConfig),
  ]);
  console.log('[esbuild] build complete ->', isProduction ? '(production)' : '(development)');
}

// 供 dev.js 复用同一份构建配置
module.exports = { extensionConfig, webviewConfig };

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
