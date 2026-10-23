/**
 * 必须在所有 remons-* 包之前 import。
 *
 * remons-render-markdown 的 markdown-it-katex 插件在模块初始化时检查 window.katex，
 * 缺失时会告警并在首次渲染时从 CDN 动态注入 <script>；而 webview 的 CSP 只允许
 * 带 nonce 的本地脚本，CDN 注入会被拦截导致公式、甚至整段预览渲染失败。
 * 这里提前挂载本地 KaTeX，ensureKatexLoaded() 检测到 window.katex 后直接返回。
 */
import katex from 'katex';
import 'katex/dist/katex.min.css';

(window as unknown as { katex?: typeof katex }).katex = katex;
