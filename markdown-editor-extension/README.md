# Remons Markdown Editor（VSCode 插件）

基于 React 组件 **`remons-markdown-editor`** 的 VSCode Markdown 可视化 **自定义编辑器**。
在编辑器工具栏 + 实时预览中编写 Markdown，内容自动同步回底层 `.md` 文件，并复用 VSCode 原生的保存 / 撤销 / 热退出能力。

## 使用
1. 打开任意 `.md` / `.markdown` 文件，**默认进入只读预览**；
2. 点击预览右下角的「编辑」按钮（或标题栏铅笔图标），切换到**可视化编辑器**（CodeMirror 编辑 + 实时预览）；
3. 点击编辑区右下角的「预览」按钮（或标题栏眼睛图标），回到**只读预览**；
4. 需要直接改源码时，点击标题栏 `</>` 图标，或执行命令 `Remons Markdown: 以文本编辑器打开`，切换到 VSCode 文本编辑器；在文本编辑器中点击标题栏眼睛图标可再打开可视化编辑器。

默认模式可通过设置 `remonsMarkdownEditor.defaultMode` 调整：`preview`（默认，只读预览）/ `edit`（可视化编辑）。

> 如需让 `.md` 默认恢复为 VSCode 文本编辑器，可在设置中将
> `workbench.editorAssociations` 的 `*.md` 关联为 `"default"`，或在文件上右键 → **打开方式…** → 选择文本编辑器。

## 开发
```bash
npm install --registry=https://registry.npmmirror.com
npm run build          # esbuild 产出 dist/
npm run watch          # 监听构建
npx @vscode/vsce package --no-dependencies   # 打包 .vsix
```

按 **F5** 启动扩展开发宿主进行调试。

> 详细设计、依赖调研与实现说明见 [docs/技术文档.md](https://github.com/liRemons/vscode-plugins/blob/main/markdown-editor-extension/docs/%E6%8A%80%E6%9C%AF%E6%96%87%E6%A1%A3.md)。
