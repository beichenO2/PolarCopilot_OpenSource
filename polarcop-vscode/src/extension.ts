import * as vscode from 'vscode';
import * as os from 'os';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { PolarClawClient } from './api/client';

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('polarcop');
  const serverUrl = config.get<string>('serverUrl', 'http://localhost:3910');
  const entryType = config.get<string>('entryType', 'ide');
  const userId = config.get<string>('userId', '') || os.userInfo().username;

  const client = new PolarClawClient(serverUrl);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'polarcop.checkConnection';
  statusBarItem.text = '$(plug) PolarCopilot';
  statusBarItem.tooltip = 'Click to check PolarClaw connection';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    context.globalState,
    serverUrl,
    entryType,
    userId
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('polarcop.chat', sidebarProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('polarcop.openChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.polarcop-sidebar');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('polarcop.sendSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }
      const text = editor.document.getText(editor.selection);
      if (!text) {
        vscode.window.showWarningMessage('No text selected');
        return;
      }
      const lang = editor.document.languageId;
      const wrapped = `\`\`\`${lang}\n${text}\n\`\`\``;
      sidebarProvider.sendMessage(wrapped);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('polarcop.clearHistory', () => {
      sidebarProvider.clearHistory();
      vscode.window.showInformationMessage('Chat history cleared');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('polarcop.checkConnection', async () => {
      statusBarItem.text = '$(sync~spin) PolarCopilot';
      const ok = await client.healthCheck();
      if (ok) {
        statusBarItem.text = '$(check) PolarCopilot';
        statusBarItem.tooltip = `Connected to ${serverUrl}`;
        vscode.window.showInformationMessage(`PolarClaw server reachable at ${serverUrl}`);
      } else {
        statusBarItem.text = '$(error) PolarCopilot';
        statusBarItem.tooltip = `Cannot reach ${serverUrl}`;
        vscode.window.showErrorMessage(
          `Cannot reach PolarClaw at ${serverUrl}. Make sure the server is running.`
        );
      }
      setTimeout(() => {
        statusBarItem.text = '$(plug) PolarCopilot';
      }, 5000);
    })
  );

  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('polarcop')) {
      const newConfig = vscode.workspace.getConfiguration('polarcop');
      const newUrl = newConfig.get<string>('serverUrl', 'http://localhost:3910');
      const newEntry = newConfig.get<string>('entryType', 'ide');
      const newUserId = newConfig.get<string>('userId', '') || os.userInfo().username;
      sidebarProvider.updateConfig(newUrl, newEntry, newUserId);
    }
  });

  client.healthCheck().then((ok) => {
    statusBarItem.text = ok ? '$(check) PolarCopilot' : '$(warning) PolarCopilot';
    statusBarItem.tooltip = ok
      ? `Connected to ${serverUrl}`
      : `PolarClaw not reachable at ${serverUrl}`;
    setTimeout(() => {
      statusBarItem.text = '$(plug) PolarCopilot';
    }, 5000);
  });
}

export function deactivate() {
  statusBarItem?.dispose();
}
