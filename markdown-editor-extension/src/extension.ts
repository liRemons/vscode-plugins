import * as vscode from 'vscode';
import {
  EditorConfig,
  ExtensionToWebviewMessage,
  ViewMode,
  WebviewToExtensionMessage,
} from './messages';

const viewType = 'remons.markdownEditor';
// 供 package.json menus.when 判断「当前是否处于可视化编辑器」的上下文键
const activeContextKey = 'remonsMarkdownEditorActive';
// 供 menus.when 判断当前视图模式（preview / edit）的上下文键
const modeContextKey = 'remonsMarkdownEditorMode';

// 所有已打开的可视化编辑器面板，用于维护 activeContextKey
const editorPanels = new Set<vscode.WebviewPanel>();
// uri -> 面板，供标题栏「切换预览 / 编辑」命令定位目标 webview
const editorPanelsByUri = new Map<string, vscode.WebviewPanel>();

function syncActiveContext(): void {
  const hasVisible = Array.from(editorPanels).some((panel) => panel.visible);
  void vscode.commands.executeCommand('setContext', activeContextKey, hasVisible);
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new RemonsMarkdownEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      viewType,
      provider,
      {
        // 隐藏 Tab 时保留 webview 状态，切回来不丢失编辑现场
        webviewOptions: { retainContextWhenHidden: true },
        // 同一个文档不允许多个可视化编辑器同时打开，避免同步冲突
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );

  context.subscriptions.push(
    // 文本编辑器 -> 可视化编辑器（预览）
    vscode.commands.registerCommand(
      'remonsMarkdownEditor.openPreview',
      async (resource?: vscode.Uri) => {
        const uri = resolveTargetUri(resource);
        if (!uri) {
          vscode.window.showInformationMessage('请先打开一个 Markdown 文件');
          return;
        }
        await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
      }
    ),
    // 可视化编辑器 -> 文本编辑器（编辑）；'default' 即 VSCode 默认编辑器
    vscode.commands.registerCommand(
      'remonsMarkdownEditor.openSource',
      async (resource?: vscode.Uri) => {
        const uri = resolveTargetUri(resource);
        if (!uri) {
          vscode.window.showInformationMessage('请先打开一个 Markdown 文件');
          return;
        }
        await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
      }
    ),
    // 标题栏按钮：切换到只读预览
    vscode.commands.registerCommand('remonsMarkdownEditor.modePreview', () =>
      switchActiveEditorMode('preview')
    ),
    // 标题栏按钮：切换到可视化编辑
    vscode.commands.registerCommand('remonsMarkdownEditor.modeEdit', () =>
      switchActiveEditorMode('edit')
    )
  );
}

/** 向当前激活的可视化编辑器发送视图模式切换指令 */
function switchActiveEditorMode(mode: ViewMode): void {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  let panel: vscode.WebviewPanel | undefined;
  if (
    tab?.input instanceof vscode.TabInputCustom &&
    tab.input.viewType === viewType
  ) {
    panel = editorPanelsByUri.get(tab.input.uri.toString());
  }
  panel ??= Array.from(editorPanelsByUri.values()).find((p) => p.visible);
  if (!panel) {
    return;
  }
  const message: ExtensionToWebviewMessage = { command: 'setMode', mode };
  void panel.webview.postMessage(message);
}

/**
 * 解析命令目标文档：
 * 优先使用菜单传入的资源 uri（资源管理器右键），
 * 否则回退到当前活动编辑器（文本编辑器 / 可视化编辑器）。
 */
function resolveTargetUri(resource?: vscode.Uri): vscode.Uri | undefined {
  if (resource instanceof vscode.Uri && isMarkdownFile(resource)) {
    return resource;
  }
  const textEditor = vscode.window.activeTextEditor;
  if (textEditor && isMarkdownFile(textEditor.document.uri)) {
    return textEditor.document.uri;
  }
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (
    tab?.input instanceof vscode.TabInputCustom &&
    tab.input.viewType === viewType &&
    isMarkdownFile(tab.input.uri)
  ) {
    return tab.input.uri;
  }
  return undefined;
}

function isMarkdownFile(uri: vscode.Uri): boolean {
  return /\.(md|markdown)$/i.test(uri.path);
}

export function deactivate() {}

/**
 * 基于底层 TextDocument 的自定义文本编辑器。
 * 脏标记 / 保存 / 另存为 / 撤销重做 / 热退出 均由 VSCode 文本文档机制托管，
 * 扩展只负责在 webview 与 TextDocument 之间做内容同步。
 */
class RemonsMarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // 只允许访问打包产物目录，收紧 CSP / 资源加载范围
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        distRoot,
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };
    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

    // 由 webview 主动发起的编辑写回文档时，跳过一次回环通知，避免编辑器光标被重置
    let suppressNextDocumentChange = false;
    // 当前视图模式：初始值来自配置，之后跟随 webview 上报（保留用户切换结果）
    let currentMode: ViewMode = getEditorConfig(document.uri).defaultMode;

    const syncModeContext = () => {
      if (webviewPanel.visible) {
        void vscode.commands.executeCommand(
          'setContext',
          modeContextKey,
          currentMode
        );
      }
    };

    const updateWebview = (command: 'load' | 'update') => {
      if (command === 'load') {
        const message: ExtensionToWebviewMessage = {
          command,
          text: document.getText(),
          config: getEditorConfig(document.uri),
        };
        webviewPanel.webview.postMessage(message);
        return;
      }
      const message: ExtensionToWebviewMessage = {
        command,
        text: document.getText(),
      };
      webviewPanel.webview.postMessage(message);
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      if (suppressNextDocumentChange) {
        // 该变化来源于 webview 自身，无需再推回 webview
        suppressNextDocumentChange = false;
        return;
      }
      // 来源于外部（撤销/重做、其它编辑器、磁盘刷新）→ 同步进 webview
      updateWebview('update');
    });

    const messageSub = webviewPanel.webview.onDidReceiveMessage(
      async (message: WebviewToExtensionMessage) => {
        switch (message.command) {
          case 'ready':
            updateWebview('load');
            break;
          case 'edit':
            await this.applyEdit(document, message.text, () => {
              suppressNextDocumentChange = true;
            });
            break;
          case 'modeChanged':
            currentMode = message.mode;
            syncModeContext();
            break;
        }
      }
    );

    editorPanels.add(webviewPanel);
    editorPanelsByUri.set(document.uri.toString(), webviewPanel);
    syncActiveContext();
    syncModeContext();
    webviewPanel.onDidChangeViewState(() => {
      syncActiveContext();
      syncModeContext();
    });

    webviewPanel.onDidDispose(() => {
      changeSub.dispose();
      messageSub.dispose();
      editorPanels.delete(webviewPanel);
      editorPanelsByUri.delete(document.uri.toString());
      syncActiveContext();
    });
  }

  /** 用整篇替换的 WorkspaceEdit 写回 TextDocument，从而复用 VSCode 的撤销/保存能力 */
  private async applyEdit(
    document: vscode.TextDocument,
    text: string,
    markSelfEdit: () => void
  ): Promise<void> {
    if (document.getText() === text) {
      return; // 内容无变化，避免制造空 undo 步骤
    }
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );
    edit.replace(document.uri, fullRange, text);
    markSelfEdit();
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      vscode.window.showErrorMessage('Remons Markdown: 写回文档失败');
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.css')
    );
    const resetUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview-reset.css')
    );

    const nonce = getNonce();
    const cspSource = webview.cspSource;

    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <!-- remons 组件库的图标/字体资源来自固定 CDN，需在 CSP 中显式放行：
       at.alicdn.com -> 工具栏 iconfont（行内代码、引用等图标）
       remons.cn:3008 -> 代码块语言图标
       fonts.gstatic.com -> 组件库默认的 Inter/NotoSansSC 字体 -->
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 img-src ${cspSource} data: blob: https://remons.cn:3008;
                 style-src ${cspSource} 'unsafe-inline' https://at.alicdn.com;
                 font-src ${cspSource} data: https://at.alicdn.com https://fonts.gstatic.com;
                 script-src 'nonce-${nonce}' https://at.alicdn.com;
                 connect-src ${cspSource} data: blob:;
                 worker-src ${cspSource} blob:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${resetUri}" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Remons Markdown Editor</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getEditorConfig(resource: vscode.Uri): EditorConfig {
  const cfg = vscode.workspace.getConfiguration('remonsMarkdownEditor', resource);
  return {
    showPreview: cfg.get<boolean>('showPreview', true),
    fullscreen: cfg.get<boolean>('fullscreen', false),
    defaultMode: cfg.get<ViewMode>('defaultMode', 'preview'),
  };
}

function getNonce(): string {
  let text = '';
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
