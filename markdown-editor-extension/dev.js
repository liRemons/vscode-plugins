// 本地浏览器预览：不启动 VS Code，直接查看 webview 界面效果
// 用法：npm run dev   ->  http://localhost:5173（?mode=edit 可直接进编辑模式）
// 原理：复用 esbuild 的 watch 构建，mock acquireVsCodeApi 并把 example/demo.md
//      作为初始内容推给 webview；改完代码自动重建，刷新页面即可看到效果。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const esbuild = require('esbuild');
const { extensionConfig, webviewConfig } = require('./esbuild');

const PORT = Number(process.env.PORT) || 5173;
const ROOT = __dirname;

const MIME_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// 与扩展宿主内 webview 的 HTML 保持一致（main.js / main.css / webview-reset.css），
// 额外提供 VSCode 主题变量与 acquireVsCodeApi mock
const devHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>Remons Markdown Editor - Dev Preview</title>
  <link rel="stylesheet" href="/media/webview-reset.css" />
  <link rel="stylesheet" href="/dist/webview/main.css" />
  <style>
    :root {
      --vscode-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
      --vscode-editor-foreground: #cccccc;
      --vscode-editor-background: #1e1e1e;
      --vscode-button-background: #313131;
      --vscode-button-foreground: #cccccc;
      --vscode-button-hoverBackground: #3c3c3c;
      --vscode-widget-border: #3c3c3c;
      --vscode-focusBorder: #0078d4;
    }
  </style>
  <script>
    (function () {
      // 最小化的 acquireVsCodeApi：收到 ready 后推送 demo 内容；
      // 其余消息（edit / modeChanged / themeChanged / immersiveChanged）仅记录，不写回文件
      var state = {};
      window.acquireVsCodeApi = function () {
        return {
          postMessage: function (msg) {
            if (!msg || typeof msg !== 'object') return;
            if (msg.command === 'ready') {
              fetch('/example/demo.md')
                .then(function (res) { return res.text(); })
                .then(function (text) {
                  window.postMessage({
                    command: 'load',
                    text: text,
                    config: {
                      showPreview: true,
                      fullscreen: false,
                      defaultMode: new URLSearchParams(location.search).get('mode') === 'edit' ? 'edit' : 'preview',
                      theme: 'dark',
                      immersive: false
                    }
                  }, '*');
                });
            } else if (msg.command === 'edit') {
              window.__lastEditText = msg.text;
            }
          },
          getState: function () { return state; },
          setState: function (next) { Object.assign(state, next); }
        };
      };
    })();
  </script>
</head>
<body class="vscode-dark">
  <div id="root"></div>
  <script src="/dist/webview/main.js"></script>
</body>
</html>`;

// 只允许读取构建产物、媒体资源与示例文档，避免暴露整个工程目录
const ALLOWED_PREFIXES = ['dist/', 'media/', 'example/'];

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }

  if (urlPath === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(devHtml);
    return;
  }

  const relative = urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, relative);
  if (
    !ALLOWED_PREFIXES.some((prefix) => relative.startsWith(prefix)) ||
    !filePath.startsWith(ROOT + path.sep)
  ) {
    res.writeHead(404).end('Not Found');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type':
        MIME_TYPES[path.extname(filePath).toLowerCase()] ||
        'application/octet-stream',
    });
    res.end(data);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[dev] 端口 ${PORT} 已被占用，可通过环境变量 PORT 指定其他端口，例如：$env:PORT=5174; npm run dev`
    );
    process.exit(1);
  }
  throw err;
});

(async () => {
  const ctxExt = await esbuild.context(extensionConfig);
  const ctxWeb = await esbuild.context(webviewConfig);
  await Promise.all([ctxExt.watch(), ctxWeb.watch()]);

  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`[dev] 浏览器预览已启动：${url}`);
    console.log('[dev] 修改 src/webview 下的代码会自动重建，刷新页面即可看到效果');
    const opener =
      process.platform === 'win32'
        ? `start "" "${url}"`
        : process.platform === 'darwin'
          ? `open "${url}"`
          : `xdg-open "${url}"`;
    exec(opener, () => {});
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
