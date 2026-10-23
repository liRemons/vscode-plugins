// Webview 运行环境的全局类型声明

/** VSCode 注入到 webview 的 API（可选泛型声明持久化状态的结构） */
declare function acquireVsCodeApi<TState = unknown>(): {
  postMessage(message: unknown): void;
  getState(): TState | undefined;
  setState(state: TState): void;
};

/** 允许在 TS 中直接 import '*.css'（由 esbuild 打包抽取） */
declare module '*.css';
