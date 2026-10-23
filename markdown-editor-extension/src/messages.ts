/**
 * 扩展宿主与 Webview 之间的消息协议（双向通信契约）
 * 放在独立文件里，供 extension.ts 与 webview/main.tsx 共同引用。
 */

/** Webview -> 扩展宿主 */
export type WebviewToExtensionMessage =
  | { command: 'ready' } // webview 内 React 应用挂载完成，请求初始内容
  | { command: 'edit'; text: string } // 编辑器内容变化，请求写回底层 TextDocument
  | { command: 'modeChanged'; mode: ViewMode } // 视图模式（只读预览 / 可视化编辑）发生变化
  | { command: 'themeChanged'; theme: ThemeMode } // 用户切换了深/浅色主题
  | { command: 'immersiveChanged'; immersive: boolean }; // 用户切换了沉浸式编辑

/**
 * 视图模式：
 * - preview：只读预览，仅渲染 Markdown，不提供编辑能力
 * - edit：可视化编辑器（CodeMirror 编辑 + 实时预览）
 */
export type ViewMode = 'preview' | 'edit';

/**
 * 主题模式：
 * - dark：深色主题（默认）
 * - light：浅色主题
 * - auto：跟随 VSCode 当前主题
 */
export type ThemeMode = 'dark' | 'light' | 'auto';

/** 编辑器展示相关配置，由扩展读取 contributes.configuration 后透传给 webview */
export interface EditorConfig {
  showPreview: boolean;
  fullscreen: boolean;
  /** 打开文件时默认进入的视图模式 */
  defaultMode: ViewMode;
  /** 主题模式，默认 dark */
  theme: ThemeMode;
  /** 是否默认处于沉浸式编辑（隐藏预览面板） */
  immersive: boolean;
}

/** 扩展宿主 -> Webview */
export type ExtensionToWebviewMessage =
  | { command: 'load'; text: string; config: EditorConfig } // 首次加载内容 + 配置
  | { command: 'update'; text: string } // 外部改动（如撤销/重做、磁盘修改）后同步内容
  | { command: 'setMode'; mode: ViewMode } // 由命令（标题栏按钮）发起的视图模式切换
  | { command: 'setTheme'; theme: ThemeMode } // 由命令发起的主题切换
  | { command: 'setImmersive'; immersive: boolean }; // 由命令发起的沉浸式编辑切换
