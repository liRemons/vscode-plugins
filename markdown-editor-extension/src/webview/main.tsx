// 必须放在所有 remons-* 包之前：提前挂载本地 KaTeX，避免组件库从 CDN 注入脚本被 CSP 拦截
import './katex-setup';
import { useEffect, useReducer, useRef, useState } from 'react';
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
  ThemeMode,
  ViewMode,
  WebviewToExtensionMessage,
} from '../messages';
import './preview-mode.css';

// acquireVsCodeApi 在单个 webview 生命周期内只能调用一次，模块顶层持有单例
const vscode = acquireVsCodeApi<{
  mode?: ViewMode;
  theme?: ThemeMode;
  immersive?: boolean;
}>();

// 面板重建时恢复上次会话的选择（没切换过则以配置为准，见 load 消息）
const savedState = vscode.getState() ?? {};

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
 * 主题解析与应用：
 * RenderMarkdown 与编辑器组件都通过 <html data-theme="dark|light"> 切换 CSS 变量。
 * - dark / light：用户显式选择，固定生效
 * - auto：跟随 VSCode 主题（webview 的 prefers-color-scheme 可能跟随系统而非编辑器，
 *   因此按 body 上的 vscode-* 类名判断）
 */
function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'auto') {
    const cl = document.body.classList;
    return cl.contains('vscode-light') ||
      cl.contains('vscode-high-contrast-light')
      ? 'light'
      : 'dark';
  }
  return mode;
}

let activeThemeMode: ThemeMode = savedState.theme ?? 'dark';

/** 应用主题，返回实际生效的深/浅色 */
function applyThemeMode(mode: ThemeMode): 'dark' | 'light' {
  activeThemeMode = mode;
  const theme = resolveTheme(mode);
  document.documentElement.dataset.theme = theme;
  // 让滚动条等原生控件也跟随主题
  document.documentElement.style.colorScheme = theme;
  // 让组件库内部的主题状态（localStorage app-theme-mode）保持一致
  try {
    localStorage.setItem('app-theme-mode', theme);
  } catch {
    // localStorage 不可用时忽略，CSS 变量仍由 data-theme 驱动
  }
  return theme;
}

// 默认深色（或恢复上次选择）：先于组件库的主题初始化生效，避免首屏停在浅色变量
applyThemeMode(activeThemeMode);

/**
 * 底部悬浮按钮的 16px 线性图标：stroke 使用 currentColor，
 * 颜色跟随按钮文本（组件库主题变量），深浅主题切换时自动生效。
 */
function EditIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.8 13.2 3.3 10.4 10.7 3a1.2 1.2 0 0 1 1.7 0l.6.6a1.2 1.2 0 0 1 0 1.7l-7.4 7.4-2.8.5Z" />
      <path d="M9.6 4.2l2.2 2.2" />
    </svg>
  );
}

function PreviewIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2.1" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.4v1.6M8 13v1.6M1.4 8h1.6M13 8h1.6M3.3 3.3l1.1 1.1M11.6 11.6l1.1 1.1M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.2 9.8A5.6 5.6 0 0 1 6.2 2.8a5.6 5.6 0 1 0 7 7Z" />
    </svg>
  );
}

/** split=true 表示双栏（显示预览），false 表示单栏沉浸 */
function PanelIcon({ split }: { split: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1.4" />
      {split && <path d="M9.2 3.5v9" />}
    </svg>
  );
}

// 写回文档前的输入防抖，避免每次按键都触发整篇 WorkspaceEdit
const EDIT_DEBOUNCE_MS = 150;

function App() {
  const [text, setText] = useState<string>('');
  const [config, setConfig] = useState<EditorConfig>({
    showPreview: true,
    fullscreen: false,
    defaultMode: 'preview',
    theme: 'dark',
    immersive: false,
  });
  // 视图模式：webview 重建时优先恢复上次模式，否则等 load 时按配置初始化
  const [mode, setMode] = useState<ViewMode>(
    () => vscode.getState()?.mode ?? 'preview'
  );
  // 主题与沉浸式编辑：同样优先恢复当前会话的选择
  const [themeMode, setThemeMode] = useState<ThemeMode>(
    () => savedState.theme ?? 'dark'
  );
  // 实际生效的深/浅色，用于按钮文案与跟随 VSCode 主题
  const [resolvedTheme, setResolvedTheme] = useState<'dark' | 'light'>(() =>
    resolveTheme(savedState.theme ?? 'dark')
  );
  const [immersive, setImmersive] = useState<boolean>(
    () => savedState.immersive ?? false
  );
  // 回到顶部按钮监听的实际滚动容器：用 querySelector 定位
  // - preview：滚动在内容区 .preview-only-content（外层只做 TOC 定位基准）
  // - edit：滚动发生在组件库预览面板 .preview 内部
  const queryBackTopTarget = (selector: string) =>
    document.querySelector<HTMLElement>(selector) ?? undefined;

  // 编辑模式：.preview 面板由 MarkdownEditor 内部晚于首帧创建，而回到顶部组件只在
  // 挂载时绑定监听容器，之后再更新 backTopTarget 不会重绑。因此先以 showBackTop=false
  // 渲染，等 querySelector 命中面板后再打开开关，让它首次挂载即绑定正确容器。
  // undefined = 面板未就绪，null = 无预览面板（沉浸式）
  const [editBackTop, setEditBackTop] = useState<HTMLElement | null>();
  useEffect(() => {
    if (mode !== 'edit') return;
    setEditBackTop(undefined);
    const timer = window.setTimeout(() => {
      setEditBackTop(
        document.querySelector<HTMLElement>('.edit-mode .preview') ?? null
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [mode, immersive, config.showPreview]);

  // .preview-only / .preview 是本次渲染才创建的元素，渲染阶段 querySelector 必然查不到；
  // 提交后强制重渲染一次，让 RenderMarkdown 在容器挂载后才初始化并绑定正确的 backTopTarget
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    forceRender();
  }, [mode, immersive, config.showPreview]);

  const editorRef = useRef<MarkdownEditorRef>(null);
  // 权威内容快照：记录当前已知的文档文本，用于识别「外部推送后编辑器回吐的 echo 变更」
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestText = useRef<string>('');
  // CodeMirror 会把 CRLF 归一化为 LF，若原样同步原始文本，编辑器回吐的 LF 会被当成
  // 用户编辑写回文档（把 CRLF 文件改成 LF 并置脏）。这里统一用 LF，写回时再还原。
  const eolRef = useRef<string>('\n');

  const normalizeEol = (value: string) => value.replace(/\r\n?/g, '\n');

  /** 合并写入 webview 状态，避免 theme / immersive 被单字段 setState 丢失 */
  const saveState = (patch: {
    mode?: ViewMode;
    theme?: ThemeMode;
    immersive?: boolean;
  }) => {
    vscode.setState({ ...vscode.getState(), ...patch });
  };

  const onModeChanged = (next: ViewMode) => {
    setMode(next);
    saveState({ mode: next });
    const message: WebviewToExtensionMessage = {
      command: 'modeChanged',
      mode: next,
    };
    vscode.postMessage(message);
  };

  const onToggleTheme = () => {
    // 按当前实际生效的深/浅色取反，auto 模式下也能切到相反主题
    const next: ThemeMode = resolvedTheme === 'light' ? 'dark' : 'light';
    setThemeMode(next);
    setResolvedTheme(applyThemeMode(next));
    saveState({ theme: next });
    const message: WebviewToExtensionMessage = {
      command: 'themeChanged',
      theme: next,
    };
    vscode.postMessage(message);
  };

  const onToggleImmersive = () => {
    const next = !immersive;
    setImmersive(next);
    saveState({ immersive: next });
    const message: WebviewToExtensionMessage = {
      command: 'immersiveChanged',
      immersive: next,
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
          const nextTheme = vscode.getState()?.theme ?? msg.config.theme;
          setThemeMode(nextTheme);
          setResolvedTheme(applyThemeMode(nextTheme));
          const nextImmersive =
            vscode.getState()?.immersive ?? msg.config.immersive;
          setImmersive(nextImmersive);
          saveState({
            mode: nextMode,
            theme: nextTheme,
            immersive: nextImmersive,
          });
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
        saveState({ mode: msg.mode });
        // 回传宿主：刷新 menus.when 的上下文键，标题栏按钮才能随之切换
        const modeMessage: WebviewToExtensionMessage = {
          command: 'modeChanged',
          mode: msg.mode,
        };
        vscode.postMessage(modeMessage);
      } else if (msg.command === 'setTheme') {
        setThemeMode(msg.theme);
        setResolvedTheme(applyThemeMode(msg.theme));
        saveState({ theme: msg.theme });
      } else if (msg.command === 'setImmersive') {
        setImmersive(msg.immersive);
        saveState({ immersive: msg.immersive });
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

  // 仅 auto 模式跟随 VSCode 主题变化（切换主题时会更新 body 上的 vscode-* 类名）
  useEffect(() => {
    if (themeMode !== 'auto') {
      return;
    }
    const observer = new MutationObserver(() => {
      setResolvedTheme(applyThemeMode('auto'));
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, [themeMode]);

  const handleChange = (value: string) => {
    // 与权威快照相同 => 属于外部推送后编辑器回吐的 echo（或无实际变化），无需回写文档
    if (value === latestText.current) {
      return;
    }
    latestText.current = value;
    setText(value);
    postEdit(value);
  };

  const themeToggleTitle =
    resolvedTheme === 'light' ? '切换到深色主题' : '切换到浅色主题';

  if (mode === 'preview') {
    // 只读预览：仅渲染 Markdown，不提供任何编辑能力
    return (
      <div className="preview-only">
        <div className="preview-only-content">
          {/* backTopTarget 在挂载时即被监听，必须等 querySelector 命中滚动容器后再渲染 */}
          {queryBackTopTarget('.preview-only-content') && (
            <RenderMarkdown
              content={text}
              isSlotMermaid
              defaultCollapsed={false}
              showBackTop
              showToc
              backTopTarget={queryBackTopTarget('.preview-only-content')}
            />
          )}
        </div>
        <div className="mode-actions">
          <button
            type="button"
            className="mode-toggle"
            title={themeToggleTitle}
            aria-label={themeToggleTitle}
            onClick={onToggleTheme}
          >
            {resolvedTheme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
          <button
            type="button"
            className="mode-toggle"
            title="切换到可视化编辑"
            aria-label="切换到可视化编辑"
            onClick={() => onModeChanged('edit')}
          >
            <EditIcon />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="edit-mode">
      <MarkdownEditor
        ref={editorRef}
        value={text}
        onChange={handleChange}
        showPreview={config.showPreview && !immersive}
        fullscreen={config.fullscreen}
        // 组件库的 mermaid 渲染是显式开关（内部条件判断无默认值），必须手动开启；
        // defaultCollapsed=false 让图表默认展开，而不是只显示 36px 标题栏；
        // showBackTop / showToc / backTopTarget 经 previewOptions 透传给内部 RenderMarkdown
        previewOptions={{
          isSlotMermaid: true,
          defaultCollapsed: false,
          showBackTop: editBackTop !== undefined,
          showToc: true,
          backTopTarget: editBackTop ?? undefined,
        }}
      />
      <div className="mode-actions">
        {config.showPreview && (
          <button
            type="button"
            className="mode-toggle"
            title={
              immersive
                ? '退出沉浸式编辑（显示预览）'
                : '沉浸式编辑（隐藏预览）'
            }
            aria-label={immersive ? '退出沉浸式编辑' : '沉浸式编辑'}
            aria-pressed={immersive}
            onClick={onToggleImmersive}
          >
            <PanelIcon split={!immersive} />
          </button>
        )}
        <button
          type="button"
          className="mode-toggle"
          title={themeToggleTitle}
          aria-label={themeToggleTitle}
          onClick={onToggleTheme}
        >
          {resolvedTheme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
        <button
          type="button"
          className="mode-toggle"
          title="切换到只读预览"
          aria-label="切换到只读预览"
          onClick={() => onModeChanged('preview')}
        >
          <PreviewIcon />
        </button>
      </div>
    </div>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
