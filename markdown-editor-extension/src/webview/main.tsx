// 必须放在所有 remons-* 包之前：提前挂载本地 KaTeX，避免组件库从 CDN 注入脚本被 CSP 拦截
import './katex-setup';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownEditor } from 'remons-markdown-editor';
import type { MarkdownEditorRef } from 'remons-markdown-editor';
import 'remons-markdown-editor/style.css';
import hljs from 'highlight.js';
import RenderMarkdown, {
  initHighlighter,
  languagesCommon,
} from 'remons-render-markdown';
import type {
  EditorConfig,
  ExtensionToWebviewMessage,
  ViewMode,
  WebviewToExtensionMessage,
} from '../messages';
import './preview-mode.css';

// acquireVsCodeApi 在单个 webview 生命周期内只能调用一次，模块顶层持有单例
const vscode = acquireVsCodeApi<{ mode?: ViewMode }>();

// 注册代码块高亮语言：组件库的 Preview 面板内部只会注册 languagesCommon（仅 7 种），
// 直接使用 RenderMarkdown 时若代码块写 python / go / sql 等语言会退化成纯文本。
// 这里从 highlight.js 完整包取出全部已注册语言（含别名，如 py / sh / c++），一并注入。
const allHighlightLanguages: Record<string, unknown> = {};
for (const name of hljs.listLanguages()) {
  const language = hljs.getLanguage(name);
  if (language) {
    allHighlightLanguages[name] = language;
  }
}
initHighlighter({ ...allHighlightLanguages, ...languagesCommon });

/**
 * RenderMarkdown 通过 <html data-theme="dark|light"> 切换深浅色变量，
 * 但 webview 的 prefers-color-scheme 不一定跟随 VSCode 编辑器主题（可能跟随系统），
 * 导致深色主题下仍是浅色定义（深色文字），这里按 body 上的 VSCode 主题类名强制同步。
 */
function syncVscodeTheme(): void {
  const cl = document.body.classList;
  const isLight =
    cl.contains('vscode-light') || cl.contains('vscode-high-contrast-light');
  const theme = isLight ? 'light' : 'dark';
  if (document.documentElement.dataset.theme === theme) {
    return;
  }
  document.documentElement.dataset.theme = theme;
  // 让组件库内部的主题状态（localStorage app-theme-mode）保持一致
  try {
    localStorage.setItem('app-theme-mode', theme);
  } catch {
    // localStorage 不可用时忽略，CSS 变量仍由 data-theme 驱动
  }
}

syncVscodeTheme();
// VSCode 切换主题时会更新 body 上的 vscode-* 类名
new MutationObserver(syncVscodeTheme).observe(document.body, {
  attributes: true,
  attributeFilter: ['class'],
});

// 写回文档前的输入防抖，避免每次按键都触发整篇 WorkspaceEdit
const EDIT_DEBOUNCE_MS = 150;

function App() {
  const [text, setText] = useState<string>('');
  const [config, setConfig] = useState<EditorConfig>({
    showPreview: true,
    fullscreen: false,
    defaultMode: 'preview',
  });
  // 视图模式：webview 重建时优先恢复上次模式，否则等 load 时按配置初始化
  const [mode, setMode] = useState<ViewMode>(
    () => vscode.getState()?.mode ?? 'preview'
  );

  const editorRef = useRef<MarkdownEditorRef>(null);
  // 权威内容快照：记录当前已知的文档文本，用于识别「外部推送后编辑器回吐的 echo 变更」
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestText = useRef<string>('');
  // CodeMirror 会把 CRLF 归一化为 LF，若原样同步原始文本，编辑器回吐的 LF 会被当成
  // 用户编辑写回文档（把 CRLF 文件改成 LF 并置脏）。这里统一用 LF，写回时再还原。
  const eolRef = useRef<string>('\n');

  const normalizeEol = (value: string) => value.replace(/\r\n?/g, '\n');

  const onModeChanged = (next: ViewMode) => {
    setMode(next);
    vscode.setState({ mode: next });
    const message: WebviewToExtensionMessage = {
      command: 'modeChanged',
      mode: next,
    };
    vscode.postMessage(message);
  };

  const postEdit = (value: string) => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    debounceTimer.current = setTimeout(() => {
      const message: WebviewToExtensionMessage = {
        command: 'edit',
        text: eolRef.current === '\n' ? value : value.replace(/\n/g, eolRef.current),
      };
      vscode.postMessage(message);
    }, EDIT_DEBOUNCE_MS);
  };

  useEffect(() => {
    const handler = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.command === 'load' || msg.command === 'update') {
        eolRef.current = msg.text.includes('\r\n') ? '\r\n' : '\n';
        const normalized = normalizeEol(msg.text);
        latestText.current = normalized;
        setText(normalized);
        if (msg.command === 'load') {
          setConfig(msg.config);
          // 当前会话未发生过切换时，采用配置的默认模式
          const nextMode = vscode.getState()?.mode ?? msg.config.defaultMode;
          setMode(nextMode);
          vscode.setState({ mode: nextMode });
          // 同步给扩展宿主，用于标题栏按钮显隐
          const modeMessage: WebviewToExtensionMessage = {
            command: 'modeChanged',
            mode: nextMode,
          };
          vscode.postMessage(modeMessage);
        }
      } else if (msg.command === 'setMode') {
        // 标题栏命令发起的切换
        setMode(msg.mode);
        vscode.setState({ mode: msg.mode });
      }
    };

    window.addEventListener('message', handler);
    // 通知扩展：webview 已就绪，请求初始内容
    vscode.postMessage({ command: 'ready' } satisfies WebviewToExtensionMessage);

    return () => {
      window.removeEventListener('message', handler);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  const handleChange = (value: string) => {
    // 与权威快照相同 => 属于外部推送后编辑器回吐的 echo（或无实际变化），无需回写文档
    if (value === latestText.current) {
      return;
    }
    latestText.current = value;
    setText(value);
    postEdit(value);
  };

  if (mode === 'preview') {
    // 只读预览：仅渲染 Markdown，不提供任何编辑能力
    return (
      <div className="preview-only">
        <div className="preview-only-content">
          <RenderMarkdown content={text} />
        </div>
        <button
          type="button"
          className="mode-toggle"
          title="切换到可视化编辑"
          onClick={() => onModeChanged('edit')}
        >
          编辑
        </button>
      </div>
    );
  }

  return (
    <div className="edit-mode">
      <MarkdownEditor
        ref={editorRef}
        value={text}
        onChange={handleChange}
        showPreview={config.showPreview}
        fullscreen={config.fullscreen}
      />
      <button
        type="button"
        className="mode-toggle"
        title="切换到只读预览"
        onClick={() => onModeChanged('preview')}
      >
        预览
      </button>
    </div>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
