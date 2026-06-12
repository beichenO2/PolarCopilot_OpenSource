import * as vscode from 'vscode';
import { PolarClawClient, type StreamEvent } from '../api/client';

interface ChatMessage {
  role: 'user' | 'assistant' | 'error';
  content: string;
  timestamp: number;
}

interface Conversation {
  id: string;
  name: string;
  messages: ChatMessage[];
  createdAt: number;
}

const CONVERSATIONS_KEY = 'polarcop.conversations';
const ACTIVE_CONV_KEY = 'polarcop.activeConversation';
const MAX_HISTORY = 100;
const MAX_CONVERSATIONS = 10;

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'polarcop.chat';

  private _view?: vscode.WebviewView;
  private _client: PolarClawClient;
  private _entryType: string;
  private _userId: string;
  private _conversations: Conversation[] = [];
  private _activeConvId: string;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _globalState: vscode.Memento,
    serverUrl: string,
    entryType: string,
    userId: string
  ) {
    this._client = new PolarClawClient(serverUrl);
    this._entryType = entryType;
    this._userId = userId;
    this._conversations = this._globalState.get<Conversation[]>(CONVERSATIONS_KEY, []);
    if (this._conversations.length === 0) {
      const first = this._createConversation();
      this._conversations.push(first);
    }
    this._activeConvId = this._globalState.get<string>(ACTIVE_CONV_KEY, this._conversations[0]!.id);
    if (!this._conversations.find(c => c.id === this._activeConvId)) {
      this._activeConvId = this._conversations[0]!.id;
    }
  }

  private _createConversation(): Conversation {
    const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    return { id, name: `Chat ${this._conversations.length + 1}`, messages: [], createdAt: Date.now() };
  }

  private _getActiveConv(): Conversation {
    return this._conversations.find(c => c.id === this._activeConvId) ?? this._conversations[0]!;
  }

  public updateConfig(serverUrl: string, entryType: string, userId: string): void {
    this._client = new PolarClawClient(serverUrl);
    this._entryType = entryType;
    this._userId = userId;
  }

  private _saveConversations(): void {
    this._globalState.update(CONVERSATIONS_KEY, this._conversations);
    this._globalState.update(ACTIVE_CONV_KEY, this._activeConvId);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          this._syncConversationsToWebview();
          break;
        case 'sendMessage':
          await this._handleChat(msg.text);
          break;
        case 'clearHistory':
          this._getActiveConv().messages = [];
          this._saveConversations();
          this._postMessage({ type: 'historyCleared' });
          break;
        case 'showHistory':
          this._postMessage({
            type: 'showHistoryPanel',
            conversations: this._conversations.map(c => ({
              id: c.id,
              name: c.name,
              msgCount: c.messages.length,
              lastMsg: c.messages.length > 0
                ? c.messages[c.messages.length - 1]!.content.slice(0, 60)
                : '(empty)',
              createdAt: c.createdAt,
            })),
          });
          break;
        case 'newConversation': {
          if (this._conversations.length >= MAX_CONVERSATIONS) {
            this._conversations.shift();
          }
          const conv = this._createConversation();
          this._conversations.push(conv);
          this._activeConvId = conv.id;
          this._client.setConversationId(null);
          this._saveConversations();
          this._syncConversationsToWebview();
          break;
        }
        case 'switchConversation': {
          const target = this._conversations.find(c => c.id === msg.id);
          if (target) {
            this._activeConvId = target.id;
            this._client.setConversationId(target.id);
            this._saveConversations();
            this._syncConversationsToWebview();
          }
          break;
        }
        case 'deleteConversation': {
          this._conversations = this._conversations.filter(c => c.id !== msg.id);
          if (this._conversations.length === 0) {
            this._conversations.push(this._createConversation());
          }
          if (this._activeConvId === msg.id) {
            this._activeConvId = this._conversations[this._conversations.length - 1]!.id;
            this._client.setConversationId(null);
          }
          this._saveConversations();
          this._syncConversationsToWebview();
          break;
        }
        case 'renameConversation': {
          const conv = this._conversations.find(c => c.id === msg.id);
          if (conv) {
            conv.name = msg.name.slice(0, 30);
            this._saveConversations();
            this._syncConversationsToWebview();
          }
          break;
        }
        case 'loadBackendHistory':
          await this._loadBackendConversations();
          break;
        case 'loadBackendConversation':
          await this._loadBackendConversation(msg.id);
          break;
      }
    });
  }

  public sendMessage(text: string): void {
    if (this._view) {
      this._addToHistory('user', text);
      this._postMessage({ type: 'appendUserMessage', text });
      this._handleChat(text);
    }
  }

  public clearHistory(): void {
    this._getActiveConv().messages = [];
    this._saveConversations();
    this._postMessage({ type: 'historyCleared' });
  }

  private _syncConversationsToWebview(): void {
    const conv = this._getActiveConv();
    this._postMessage({
      type: 'loadState',
      conversations: this._conversations.map(c => ({ id: c.id, name: c.name, msgCount: c.messages.length })),
      activeId: this._activeConvId,
      messages: conv.messages,
    });
  }

  private async _handleChat(text: string): Promise<void> {
    this._addToHistory('user', text);
    this._postMessage({ type: 'startAssistant' });

    try {
      let fullResponse = '';
      await this._client.chat(
        text, this._entryType, this._userId,
        (chunk) => {
          fullResponse += chunk;
          this._postMessage({ type: 'appendChunk', chunk });
        },
        (event: StreamEvent) => {
          this._postMessage({ type: 'streamEvent', event });
        },
      );
      this._addToHistory('assistant', fullResponse);
      this._postMessage({ type: 'endAssistant' });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this._addToHistory('error', errMsg);
      this._postMessage({ type: 'error', message: errMsg });
      this._postMessage({ type: 'endAssistant' });
    }
  }

  private _addToHistory(role: ChatMessage['role'], content: string): void {
    const conv = this._getActiveConv();
    conv.messages.push({ role, content, timestamp: Date.now() });
    if (conv.messages.length > MAX_HISTORY) {
      conv.messages = conv.messages.slice(-MAX_HISTORY);
    }
    if (conv.messages.length === 1 && role === 'user') {
      conv.name = content.slice(0, 20) || conv.name;
    }
    this._saveConversations();
  }

  private _postMessage(message: unknown): void {
    this._view?.webview.postMessage(message);
  }

  private async _loadBackendConversations(): Promise<void> {
    try {
      const list = await this._client.listConversations(30);
      this._postMessage({
        type: 'showBackendHistory',
        conversations: list.map(c => ({
          id: c.conversationId,
          messageCount: c.messageCount,
          lastMessageAt: c.lastMessageAt,
          preview: c.preview,
        })),
      });
    } catch {
      this._postMessage({ type: 'error', message: 'Failed to load conversation history from backend' });
    }
  }

  private async _loadBackendConversation(id: string): Promise<void> {
    try {
      const conv = await this._client.getConversation(id);
      this._client.setConversationId(conv.conversationId);
      this._postMessage({
        type: 'loadBackendConversation',
        id: conv.conversationId,
        messages: conv.messages,
      });
    } catch {
      this._postMessage({ type: 'error', message: 'Failed to load conversation' });
    }
  }

  private _getHtml(webview: vscode.Webview): string {
    const markedUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'marked.umd.js')
    );
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PolarCopilot Chat</title>
  <style>
    :root {
      --radius: 8px;
      --gap: 8px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      font-weight: 600;
      font-size: 13px;
    }
    .header-actions { display: flex; gap: 4px; }
    .header-btn {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      opacity: 0.7;
      font-size: 14px;
    }
    .header-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

    /* Conversation tabs */
    .conv-tabs {
      display: flex;
      align-items: center;
      padding: 4px 8px;
      gap: 2px;
      border-bottom: 1px solid var(--vscode-panel-border);
      overflow-x: auto;
      scrollbar-width: thin;
    }
    .conv-tabs::-webkit-scrollbar { height: 3px; }
    .conv-tab {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
      opacity: 0.6;
      border: 1px solid transparent;
      background: none;
      color: var(--vscode-foreground);
    }
    .conv-tab:hover { opacity: 0.9; background: var(--vscode-list-hoverBackground); }
    .conv-tab.active {
      opacity: 1;
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      border-color: var(--vscode-focusBorder);
    }
    .conv-tab .close-tab {
      font-size: 10px;
      opacity: 0;
      padding: 0 2px;
      border-radius: 2px;
    }
    .conv-tab:hover .close-tab { opacity: 0.7; }
    .conv-tab .close-tab:hover { opacity: 1; background: rgba(255,80,80,0.3); }
    .new-conv-btn {
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 13px;
      cursor: pointer;
      opacity: 0.6;
      background: none;
      border: 1px dashed var(--vscode-panel-border);
      color: var(--vscode-foreground);
      white-space: nowrap;
    }
    .new-conv-btn:hover { opacity: 1; border-style: solid; }

    /* Messages */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: var(--gap);
    }
    .msg {
      padding: 10px 14px;
      border-radius: var(--radius);
      line-height: 1.5;
      word-wrap: break-word;
      max-width: 95%;
    }
    .msg.user {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      align-self: flex-end;
      border-bottom-right-radius: 2px;
    }
    .msg.assistant {
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.15));
      align-self: flex-start;
      border-bottom-left-radius: 2px;
    }
    .msg.error {
      background: rgba(255, 80, 80, 0.12);
      border-left: 3px solid var(--vscode-errorForeground, #f44);
      align-self: flex-start;
      font-size: 12px;
    }
    .msg.assistant pre {
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
      padding: 10px 12px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 6px 0;
      font-size: 12px;
      line-height: 1.4;
    }
    .msg.assistant code {
      font-family: var(--vscode-editor-font-family, 'Menlo', monospace);
      font-size: 12px;
    }
    .msg.assistant :not(pre) > code {
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.15));
      padding: 1px 5px;
      border-radius: 3px;
    }
    .msg.assistant p { margin: 4px 0; }
    .msg.assistant ul, .msg.assistant ol { margin: 4px 0; padding-left: 20px; }
    .msg.assistant h1, .msg.assistant h2, .msg.assistant h3 {
      margin: 8px 0 4px;
      font-size: 1em;
      font-weight: 700;
    }
    .msg.assistant blockquote {
      border-left: 3px solid var(--vscode-textBlockQuote-border, #666);
      padding: 4px 10px;
      margin: 4px 0;
      opacity: 0.85;
    }

    /* Copy button */
    .code-wrapper { position: relative; }
    .copy-btn {
      position: absolute;
      top: 4px;
      right: 4px;
      background: var(--vscode-button-secondaryBackground, #555);
      color: var(--vscode-button-secondaryForeground, #fff);
      border: none;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 11px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.2s;
    }
    .code-wrapper:hover .copy-btn { opacity: 1; }

    /* Typing indicator */
    .typing { display: flex; gap: 4px; padding: 8px 14px; }
    .typing span {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--vscode-foreground);
      opacity: 0.4;
      animation: blink 1.4s infinite both;
    }
    .typing span:nth-child(2) { animation-delay: 0.2s; }
    .typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes blink {
      0%, 80%, 100% { opacity: 0.15; }
      40% { opacity: 0.6; }
    }

    /* StepFlow panel */
    .stepflow-panel {
      margin: 4px 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
      font-size: 12px;
    }
    .stepflow-panel .sf-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: rgba(255,255,255,0.03);
      cursor: pointer;
      user-select: none;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .stepflow-panel .sf-header:hover { background: rgba(255,255,255,0.05); }
    .stepflow-panel .sf-header .sf-chevron { font-size: 9px; transition: transform 0.15s; }
    .stepflow-panel .sf-header.collapsed .sf-chevron { transform: rotate(-90deg); }
    .stepflow-panel .sf-header .sf-title { flex: 1; font-weight: 500; }
    .stepflow-panel .sf-header .sf-badge {
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 10px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .stepflow-panel .sf-header .sf-badge.model { background: rgba(78,201,101,0.1); color: #4ec965; }
    .stepflow-panel .sf-header .sf-badge.count { background: rgba(0,120,212,0.1); color: var(--vscode-textLink-foreground); }

    .sf-tree {
      padding: 4px 8px 8px 12px;
      border-left: 1px solid var(--vscode-panel-border);
      margin-left: 14px;
    }
    .sf-tree.hidden { display: none; }

    .sf-node {
      position: relative;
      padding: 2px 0 2px 10px;
    }
    .sf-node::before {
      content: '';
      position: absolute;
      left: 0;
      top: 10px;
      width: 8px;
      height: 1px;
      background: var(--vscode-panel-border);
    }
    .sf-row {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 2px 6px;
      border-radius: 3px;
      cursor: pointer;
      transition: background 0.1s;
    }
    .sf-row:hover { background: var(--vscode-list-hoverBackground); }
    .sf-icon { font-size: 10px; width: 14px; text-align: center; flex-shrink: 0; }
    .sf-icon.running { color: var(--vscode-textLink-foreground); animation: pulse 1.5s infinite; }
    .sf-icon.success { color: #4ec965; }
    .sf-icon.error { color: var(--vscode-errorForeground, #f44); }
    .sf-icon.pending { color: var(--vscode-descriptionForeground); }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
    .sf-label {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sf-meta {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, monospace);
      flex-shrink: 0;
    }
    .sf-detail {
      margin: 2px 0 2px 19px;
      padding: 4px 8px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--vscode-descriptionForeground);
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 120px;
      overflow-y: auto;
      display: none;
    }
    .sf-detail.expanded { display: block; }
    .sf-thinking {
      padding: 3px 10px;
      margin: 2px 0 2px 14px;
      border-left: 2px solid rgba(255,255,255,0.06);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      max-height: 24px;
      overflow: hidden;
      cursor: pointer;
      transition: max-height 0.2s;
    }
    .sf-thinking.expanded { max-height: 300px; overflow-y: auto; font-style: normal; }

    /* Empty state */
    .empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      opacity: 0.5;
      text-align: center;
      padding: 20px;
      gap: 8px;
    }
    .empty-state .icon { font-size: 32px; }

    /* Annotation popover */
    .ann-popover {
      position: fixed;
      z-index: 100;
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-focusBorder);
      border-radius: 8px;
      padding: 10px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      display: none;
      flex-direction: column;
      gap: 6px;
      min-width: 250px;
      max-width: 90vw;
    }
    .ann-popover.visible { display: flex; }
    .ann-popover .ann-quote {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      border-left: 2px solid var(--vscode-focusBorder);
      padding: 2px 8px;
      max-height: 40px;
      overflow: hidden;
      font-style: italic;
    }
    .ann-popover textarea {
      width: 100%;
      padding: 6px 10px;
      border: 1px solid var(--vscode-input-border, #444);
      border-radius: 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: inherit;
      font-size: 12px;
      resize: vertical;
      min-height: 32px;
      max-height: 200px;
      line-height: 1.4;
    }
    .ann-popover textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
    .ann-popover .ann-actions { display: flex; gap: 6px; justify-content: flex-end; }
    .ann-popover .ann-actions button {
      padding: 3px 10px;
      border: none;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
    }
    .ann-popover .ann-add {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .ann-popover .ann-cancel {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ccc);
    }
    .ann-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin: 2px 4px;
      padding: 2px 8px;
      font-size: 11px;
      background: rgba(56,139,253,0.12);
      border: 1px solid rgba(56,139,253,0.3);
      border-radius: 4px;
      color: var(--vscode-textLink-foreground, #3794ff);
    }
    .ann-badge .ann-remove {
      cursor: pointer;
      opacity: 0.6;
      font-size: 10px;
    }
    .ann-badge .ann-remove:hover { opacity: 1; color: #f44; }
    mark.pc-ann {
      background: rgba(56,139,253,0.15);
      border-bottom: 2px solid rgba(56,139,253,0.5);
      padding: 0 1px;
      border-radius: 2px;
    }

    /* Input area */
    #input-area {
      padding: 10px 12px;
      border-top: 1px solid var(--vscode-panel-border);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    #annotations-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    #input-row {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }
    #input {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid var(--vscode-input-border, #444);
      border-radius: 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: inherit;
      font-size: inherit;
      resize: none;
      min-height: 80px;
      max-height: 500px;
      line-height: 1.5;
      overflow: hidden;
    }
    #input:focus { outline: none; border-color: var(--vscode-focusBorder); }
    #send-btn {
      padding: 8px 14px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      min-height: 36px;
    }
    #send-btn:hover { background: var(--vscode-button-hoverBackground); }
    #send-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    /* Markdown table */
    .msg table { border-collapse: collapse; width: 100%; margin: 8px 0; }
    .msg th, .msg td { border: 1px solid var(--vscode-panel-border, #444); padding: 6px 10px; text-align: left; }
    .msg th { background: var(--vscode-editor-background, #1e1e1e); font-weight: 600; }
    .msg tr:nth-child(even) { background: rgba(255,255,255,0.03); }

    /* Markdown block elements */
    .msg h1, .msg h2, .msg h3 { margin: 10px 0 4px; }
    .msg blockquote { border-left: 3px solid var(--vscode-textBlockQuote-border, #555); padding: 4px 10px; margin: 6px 0; opacity: 0.85; }
    .msg ul, .msg ol { margin: 4px 0 4px 18px; }
    .msg hr { border: none; border-top: 1px solid var(--vscode-panel-border, #444); margin: 8px 0; }
  </style>
</head>
<body>
  <div class="header">
    <span>PolarCopilot</span>
    <div class="header-actions">
      <button class="header-btn" id="history-btn" title="View conversation history">&#x1F4CB;</button>
    </div>
  </div>
  <div class="conv-tabs" id="conv-tabs"></div>
  <div id="messages">
    <div class="empty-state" id="empty-state">
      <div class="icon">&#x2B50;</div>
      <div>Ask anything or select code and press Cmd+Shift+L</div>
    </div>
  </div>
  <div class="ann-popover" id="ann-popover">
    <div class="ann-quote" id="ann-quote"></div>
    <textarea id="ann-input" placeholder="写下你的批注..." rows="1"></textarea>
    <div class="ann-actions">
      <button class="ann-cancel" id="ann-cancel">取消</button>
      <button class="ann-add" id="ann-add">添加 (⌘Enter)</button>
    </div>
  </div>
  <div id="input-area">
    <div id="annotations-bar"></div>
    <div id="input-row">
      <textarea id="input" rows="3" placeholder="输入消息... (⌘+Enter 发送, 选中回复文本可添加批注)"></textarea>
      <button id="send-btn">&#x2191;</button>
    </div>
  </div>

  <script src="${markedUri}"></script>
  <script>
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('input');
    const sendBtn = document.getElementById('send-btn');
    const clearBtn = document.getElementById('history-btn');
    const emptyState = document.getElementById('empty-state');
    const convTabsEl = document.getElementById('conv-tabs');

    let currentAssistantEl = null;
    let currentAssistantText = '';
    let isLoading = false;

    function renderTabs(conversations, activeId) {
      convTabsEl.innerHTML = '';
      for (const c of conversations) {
        const tab = document.createElement('button');
        tab.className = 'conv-tab' + (c.id === activeId ? ' active' : '');
        tab.innerHTML = escapeHtml(c.name.slice(0, 16)) +
          '<span class="close-tab" data-id="' + c.id + '">&times;</span>';
        tab.addEventListener('click', (e) => {
          if (e.target.classList.contains('close-tab')) {
            vscode.postMessage({ type: 'deleteConversation', id: e.target.dataset.id });
          } else {
            vscode.postMessage({ type: 'switchConversation', id: c.id });
          }
        });
        convTabsEl.appendChild(tab);
      }
      const newBtn = document.createElement('button');
      newBtn.className = 'new-conv-btn';
      newBtn.textContent = '+';
      newBtn.title = 'New conversation';
      newBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'newConversation' });
      });
      convTabsEl.appendChild(newBtn);
    }

    marked.setOptions({ gfm: true, breaks: true });

    function renderMarkdown(text) {
      const raw = marked.parse(text);
      const html = raw.replace(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g,
        (_, attrs, code) => '<div class="code-wrapper"><pre><code' + attrs + '>' + code + '</code></pre><button class="copy-btn" onclick="copyCode(this)">Copy</button></div>'
      );
      return html;
    }

    function hideEmpty() {
      if (emptyState) emptyState.style.display = 'none';
    }

    function addMsg(role, content) {
      hideEmpty();
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      if (role === 'assistant') {
        div.innerHTML = renderMarkdown(content);
      } else {
        div.textContent = content;
      }
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    const annPopover = document.getElementById('ann-popover');
    const annQuote = document.getElementById('ann-quote');
    const annInput = document.getElementById('ann-input');
    const annBar = document.getElementById('annotations-bar');
    let annotations = [];
    let annotatingText = '';

    function autoResizeInput() {
      inputEl.style.overflow = 'hidden';
      inputEl.style.height = 'auto';
      const desired = Math.max(inputEl.scrollHeight, 80);
      inputEl.style.height = Math.min(desired, 500) + 'px';
      inputEl.style.overflow = desired > 500 ? 'auto' : 'hidden';
    }

    function autoResizeAnnInput() {
      annInput.style.height = 'auto';
      annInput.style.height = Math.max(annInput.scrollHeight, 32) + 'px';
    }

    function renderAnnotations() {
      annBar.innerHTML = '';
      annotations.forEach((a, i) => {
        const badge = document.createElement('span');
        badge.className = 'ann-badge';
        badge.innerHTML = '#' + (i+1) + ' "' + escapeHtml(a.text.slice(0, 20)) + (a.text.length > 20 ? '...' : '') + '" <span class="ann-remove" data-idx="' + i + '">&times;</span>';
        badge.querySelector('.ann-remove').addEventListener('click', () => {
          annotations.splice(i, 1);
          renderAnnotations();
        });
        annBar.appendChild(badge);
      });
      annBar.style.display = annotations.length > 0 ? 'flex' : 'none';
    }

    function showAnnotationPopover(text, rect) {
      annotatingText = text;
      annQuote.textContent = '"' + text.slice(0, 80) + (text.length > 80 ? '...' : '') + '"';
      annInput.value = '';
      annPopover.style.top = rect.bottom + 4 + 'px';
      annPopover.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 280)) + 'px';
      annPopover.classList.add('visible');
      annInput.focus();
    }

    function hideAnnotationPopover() {
      annPopover.classList.remove('visible');
      annotatingText = '';
    }

    function addAnnotation() {
      const note = annInput.value.trim();
      if (!note || !annotatingText) return;
      annotations.push({ text: annotatingText, note: note });
      renderAnnotations();
      hideAnnotationPopover();
    }

    document.getElementById('ann-add').addEventListener('click', addAnnotation);
    document.getElementById('ann-cancel').addEventListener('click', hideAnnotationPopover);
    annInput.addEventListener('input', autoResizeAnnInput);
    annInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addAnnotation(); }
      if (e.key === 'Escape') hideAnnotationPopover();
    });

    document.addEventListener('mouseup', () => {
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const text = sel.toString().trim();
        if (text.length < 2) return;
        const range = sel.getRangeAt(0);
        const msgEl = range.commonAncestorContainer.parentElement?.closest('.msg.assistant');
        if (!msgEl) return;
        const rect = range.getBoundingClientRect();
        showAnnotationPopover(text, rect);
      }, 50);
    });

    function send() {
      const parts = [];
      const text = inputEl.value.trim();
      if (text) parts.push(text);
      if (annotations.length > 0) {
        const annParts = annotations.map((a, i) => '【批注 ' + (i+1) + '】"' + a.text + '"\\n→ ' + a.note);
        parts.push(annParts.join('\\n\\n'));
      }
      if (parts.length === 0 || isLoading) return;
      const fullText = parts.join('\\n\\n');
      inputEl.value = '';
      annotations = [];
      renderAnnotations();
      autoResizeInput();
      addMsg('user', fullText);
      vscode.postMessage({ type: 'sendMessage', text: fullText });
    }

    window.copyCode = function(btn) {
      const code = btn.previousElementSibling.textContent;
      navigator.clipboard.writeText(code);
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    };

    inputEl.addEventListener('input', autoResizeInput);

    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    const historyBtn = document.getElementById('history-btn');
    historyBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'showHistory' });
    });

    renderAnnotations();

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'loadState':
          renderTabs(msg.conversations, msg.activeId);
          messagesEl.innerHTML = '';
          if (msg.messages && msg.messages.length > 0) {
            hideEmpty();
            for (const m of msg.messages) {
              addMsg(m.role, m.content);
            }
          } else {
            if (emptyState) { emptyState.style.display = ''; messagesEl.appendChild(emptyState); }
          }
          break;
        case 'loadHistory':
          messagesEl.innerHTML = '';
          if (msg.messages && msg.messages.length > 0) {
            hideEmpty();
            for (const m of msg.messages) {
              addMsg(m.role, m.content);
            }
          }
          break;
        case 'appendUserMessage':
          addMsg('user', msg.text);
          break;
        case 'startAssistant':
          hideEmpty();
          isLoading = true;
          sendBtn.disabled = true;
          currentAssistantText = '';
          currentAssistantEl = document.createElement('div');
          currentAssistantEl.className = 'msg assistant';
          const typing = document.createElement('div');
          typing.className = 'typing';
          typing.id = 'typing-indicator';
          typing.innerHTML = '<span></span><span></span><span></span>';
          currentAssistantEl.appendChild(typing);
          messagesEl.appendChild(currentAssistantEl);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;
        case 'streamEvent':
          if (currentAssistantEl && msg.event) {
            handleStepFlowEvent(msg.event);
          }
          break;
        case 'appendChunk':
          if (currentAssistantEl) {
            currentAssistantText += msg.chunk;
            currentAssistantEl.innerHTML = renderMarkdown(currentAssistantText);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
          break;
        case 'endAssistant':
          isLoading = false;
          sendBtn.disabled = false;
          currentAssistantEl = null;
          currentAssistantText = '';
          resetStepFlow();
          break;
        case 'error':
          addMsg('error', msg.message);
          break;
        case 'historyCleared':
          messagesEl.innerHTML = '';
          if (emptyState) {
            emptyState.style.display = '';
            messagesEl.appendChild(emptyState);
          }
          break;
        case 'showHistoryPanel':
          messagesEl.innerHTML = '';
          hideEmpty();
          const histDiv = document.createElement('div');
          histDiv.style.cssText = 'padding: 12px; display: flex; flex-direction: column; gap: 8px;';
          histDiv.innerHTML = '<h3 style="margin:0 0 8px; font-size:13px; opacity:0.8;">Local Sessions</h3>';
          for (const c of msg.conversations) {
            const item = document.createElement('div');
            item.style.cssText = 'padding: 8px 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; cursor: pointer; font-size: 12px;';
            item.innerHTML = '<div style="font-weight:600;">' + escapeHtml(c.name) + ' <span style="opacity:0.5;">(' + c.msgCount + ' msgs)</span></div><div style="opacity:0.6; font-size:11px; margin-top:2px;">' + escapeHtml(c.lastMsg) + '</div>';
            item.addEventListener('click', () => {
              vscode.postMessage({ type: 'switchConversation', id: c.id });
            });
            histDiv.appendChild(item);
          }
          const loadBtn = document.createElement('button');
          loadBtn.style.cssText = 'margin-top: 8px; padding: 6px 12px; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ccc); border: none; border-radius: 4px; cursor: pointer; font-size: 12px;';
          loadBtn.textContent = 'Load from Server...';
          loadBtn.addEventListener('click', () => { vscode.postMessage({ type: 'loadBackendHistory' }); });
          histDiv.appendChild(loadBtn);
          messagesEl.appendChild(histDiv);
          messagesEl.scrollTop = 0;
          break;
        case 'showBackendHistory':
          messagesEl.innerHTML = '';
          hideEmpty();
          const bhDiv = document.createElement('div');
          bhDiv.style.cssText = 'padding: 12px; display: flex; flex-direction: column; gap: 8px;';
          bhDiv.innerHTML = '<h3 style="margin:0 0 8px; font-size:13px; opacity:0.8;">Server History</h3>';
          if (!msg.conversations || msg.conversations.length === 0) {
            bhDiv.innerHTML += '<div style="opacity:0.5; font-size:12px;">No conversations found on server.</div>';
          } else {
            for (const c of msg.conversations) {
              const item = document.createElement('div');
              item.style.cssText = 'padding: 8px 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; cursor: pointer; font-size: 12px; transition: background 0.1s;';
              item.innerHTML = '<div style="font-weight:600;">' + escapeHtml(c.preview || c.id) + ' <span style="opacity:0.5;">(' + c.messageCount + ' msgs)</span></div><div style="opacity:0.5; font-size:10px; margin-top:2px;">' + escapeHtml(c.lastMessageAt || '') + '</div>';
              item.addEventListener('click', () => { vscode.postMessage({ type: 'loadBackendConversation', id: c.id }); });
              item.addEventListener('mouseenter', () => { item.style.background = 'var(--vscode-list-hoverBackground)'; });
              item.addEventListener('mouseleave', () => { item.style.background = ''; });
              bhDiv.appendChild(item);
            }
          }
          const backBtn = document.createElement('button');
          backBtn.style.cssText = 'margin-top: 4px; padding: 4px 10px; background: none; color: var(--vscode-textLink-foreground); border: none; cursor: pointer; font-size: 11px; text-align: left;';
          backBtn.textContent = '\\u2190 Back to local sessions';
          backBtn.addEventListener('click', () => { vscode.postMessage({ type: 'showHistory' }); });
          bhDiv.appendChild(backBtn);
          messagesEl.appendChild(bhDiv);
          messagesEl.scrollTop = 0;
          break;
        case 'loadBackendConversation':
          messagesEl.innerHTML = '';
          hideEmpty();
          if (msg.messages && msg.messages.length > 0) {
            for (const m of msg.messages) {
              addMsg(m.role === 'user' ? 'user' : m.role === 'error' ? 'error' : 'assistant', m.content || '');
            }
          }
          break;
      }
    });

    // === StepFlow v2: Hierarchical Task Tree ===
    let sfPanel = null;
    let sfTreeEl = null;
    let sfSteps = [];
    let sfModel = '';
    let sfStartTime = 0;

    function initStepFlowPanel() {
      if (sfPanel) return;
      sfPanel = document.createElement('div');
      sfPanel.className = 'stepflow-panel';
      sfPanel.innerHTML = '<div class="sf-header" id="sf-header"><span class="sf-chevron">\\u25BC</span><span class="sf-title">Agent Steps</span><span class="sf-badge count" id="sf-count">0</span><span class="sf-badge model" id="sf-model" style="display:none"></span></div><div class="sf-tree" id="sf-tree"></div>';
      if (currentAssistantEl) {
        currentAssistantEl.parentNode.insertBefore(sfPanel, currentAssistantEl);
      } else {
        messagesEl.appendChild(sfPanel);
      }
      sfTreeEl = document.getElementById('sf-tree');
      document.getElementById('sf-header').addEventListener('click', () => {
        const h = document.getElementById('sf-header');
        h.classList.toggle('collapsed');
        sfTreeEl.classList.toggle('hidden');
      });
      sfSteps = [];
      sfModel = '';
      sfStartTime = Date.now();
    }

    function addStepNode(icon, cls, label, detail, duration) {
      const node = document.createElement('div');
      node.className = 'sf-node';
      let html = '<div class="sf-row"><span class="sf-icon ' + cls + '">' + icon + '</span><span class="sf-label">' + escapeHtml(label) + '</span>';
      if (duration) html += '<span class="sf-meta">' + duration + '</span>';
      html += '</div>';
      if (detail) {
        html += '<div class="sf-detail">' + escapeHtml(detail) + '</div>';
        node.innerHTML = html;
        node.querySelector('.sf-row').addEventListener('click', () => {
          node.querySelector('.sf-detail').classList.toggle('expanded');
        });
      } else {
        node.innerHTML = html;
      }
      return node;
    }

    function updateLastStepStatus(icon, cls, duration) {
      if (!sfTreeEl) return;
      const nodes = sfTreeEl.querySelectorAll('.sf-node');
      if (nodes.length === 0) return;
      const last = nodes[nodes.length - 1];
      const iconEl = last.querySelector('.sf-icon');
      if (iconEl) { iconEl.textContent = icon; iconEl.className = 'sf-icon ' + cls; }
      if (duration) {
        let metaEl = last.querySelector('.sf-meta');
        if (!metaEl) {
          metaEl = document.createElement('span');
          metaEl.className = 'sf-meta';
          last.querySelector('.sf-row').appendChild(metaEl);
        }
        metaEl.textContent = duration;
      }
    }

    function handleStepFlowEvent(evt) {
      initStepFlowPanel();
      const countEl = document.getElementById('sf-count');
      const modelEl = document.getElementById('sf-model');

      if (evt.type === 'thinking') {
        const existing = sfTreeEl.querySelector('.sf-thinking');
        if (existing) {
          existing.textContent = 'Thinking (round ' + (evt.round || '?') + ')...';
        } else {
          const th = document.createElement('div');
          th.className = 'sf-thinking';
          th.textContent = 'Thinking (round ' + (evt.round || '?') + ')...';
          th.addEventListener('click', () => th.classList.toggle('expanded'));
          sfTreeEl.appendChild(th);
        }
      } else if (evt.type === 'tool_call') {
        const label = (evt.tool || 'tool') + (evt.args && evt.args.path ? '  ' + evt.args.path : evt.args && evt.args.command ? '  ' + String(evt.args.command).slice(0, 40) : '');
        const node = addStepNode('\\u25CF', 'running', label, null, null);
        sfTreeEl.appendChild(node);
        sfSteps.push({ tool: evt.tool, call_id: evt.call_id, startTime: Date.now() });
        if (countEl) countEl.textContent = String(sfSteps.length);
      } else if (evt.type === 'tool_result') {
        const dur = evt.duration_ms ? (evt.duration_ms / 1000).toFixed(1) + 's' : '';
        const icon = evt.success !== false ? '\\u2713' : '\\u2717';
        const cls = evt.success !== false ? 'success' : 'error';
        updateLastStepStatus(icon, cls, dur);
        if (evt.result) {
          const nodes = sfTreeEl.querySelectorAll('.sf-node');
          if (nodes.length > 0) {
            const last = nodes[nodes.length - 1];
            if (!last.querySelector('.sf-detail')) {
              const detail = document.createElement('div');
              detail.className = 'sf-detail';
              detail.textContent = evt.result.slice(0, 500);
              last.appendChild(detail);
              last.querySelector('.sf-row').addEventListener('click', () => {
                detail.classList.toggle('expanded');
              });
            }
          }
        }
      } else if (evt.type === 'done') {
        if (evt.model && modelEl) {
          modelEl.textContent = evt.model;
          modelEl.style.display = '';
        }
        const elapsed = ((Date.now() - sfStartTime) / 1000).toFixed(1) + 's';
        const titleEl = sfPanel.querySelector('.sf-title');
        if (titleEl) titleEl.textContent = 'Agent Steps (' + elapsed + ')';
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function resetStepFlow() {
      sfPanel = null;
      sfTreeEl = null;
      sfSteps = [];
      sfModel = '';
      sfStartTime = 0;
    }

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
