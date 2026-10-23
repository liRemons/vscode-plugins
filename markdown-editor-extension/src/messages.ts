/**
 * 扩展宿主与 Webview 之间的消息协议（双向通信契约）
 * 放在独立文件里，供 extension.ts 与 webview/main.tsx 共同引用。
 */

/** Webview -> 扩展宿主 */
export type WebviewToExtensionMessage =
  | { command: 'ready' } // webview 内 React 应用挂载完成，请求初始内容
  | { command: 'edit'; text: string } // 编辑器内容变化，请求写回底层 TextDocument
  | { command: 'modeChanged'; mode: ViewMode }; // 视图模式（只读预览 / 可视化编辑）发生变化

/**
 * 视图模式：
 * - preview：只读预览，仅渲染 Markdown，不提供编辑能力
 * - edit：可视化编辑器（CodeMirror 编辑 + 实时预览）
 */
export type ViewMode = 'preview' | 'edit';

/** 编辑器展示相关配置，由扩展读取 contributes.configuration 后透传给 webview */
export interface EditorConfig {
  showPreview: boolean;
  fullscreen: boolean;
  /** 打开文件时默认进入的视图模式 */
  defaultMode: ViewMode;
}

/** 扩展宿主 -> Webview */
export type ExtensionToWebviewMessage =
  | { command: 'load'; text: string; config: EditorConfig } // 首次加载内容 + 配置
  | { command: 'update'; text: string } // 外部改动（如撤销/重做、磁盘修改）后同步内容
  | { command: 'setMode'; mode: ViewMode }; // 由命令（标题栏按钮）发起的视图模式切换
