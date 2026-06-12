# PolarClaw VSCode Extension

PolarClaw AI Assistant for VSCode and Cursor IDE.

## Features

- Sidebar chat panel with streaming responses
- Code block rendering with syntax highlighting
- Send selected code to chat
- Configurable server URL and entry type

## Installation

### From VSIX

```bash
npm install
npm run compile
npm run package
# Install the generated .vsix file in VSCode
```

### Development

```bash
npm install
npm run watch
# Press F5 in VSCode to launch Extension Development Host
```

## Configuration

Open VSCode settings and search for "PolarClaw":

| Setting | Default | Description |
|---------|---------|-------------|
| `polarcop.serverUrl` | `http://localhost:3910` | PolarClaw server URL |
| `polarcop.entryType` | `ide` | Entry type for prompt template |

## Commands

| Command | Description |
|---------|-------------|
| `PolarClaw: Open Chat` | Open the sidebar chat panel |
| `PolarClaw: Send Selection to Chat` | Send selected text to chat |

## Architecture

```
packages/polarclaw-vscode/
├── src/
│   ├── extension.ts          # Extension entry point
│   ├── sidebar/
│   │   └── SidebarProvider.ts # WebView provider for chat panel
│   ├── api/
│   │   └── client.ts         # PolarClaw API client with SSE
│   └── utils/
│       └── config.ts         # Configuration utilities
└── webview/                  # WebView frontend (future)
```

## API Integration

The extension communicates with PolarClaw backend via:

- `POST /api/chat` - Chat endpoint with SSE streaming
- `X-Entry-Type: ide` header - Identifies IDE entry point

## License

MIT
