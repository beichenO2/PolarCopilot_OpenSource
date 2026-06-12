# polarcop-vscode — PolarCopilot 的 IDE 入口插件

> 原名 polarclaw-vscode，2026-05-17 迁移至 PolarCopilot。为 VSCode/Cursor 提供侧边栏对话面板与代码感知能力，是 PolarCopilot IDE Agent 框架的前端载体。

---

## 设计哲学

- **轻量桥梁**: 本扩展不包含任何 LLM 逻辑，纯粹作为 IDE 与 PolarClaw 后端之间的通信桥梁；所有 AI 能力由 PolarClaw 提供
- **IDE-native**: 深度遵循 VSCode 扩展 API 规范，WebView 面板复用 VSCode 主题变量（`--vscode-*`），确保视觉与交互一致性
- **代码感知**: 通过 `sendSelection` 命令将编辑器选中文本直接注入对话上下文，实现"选中即问"的代码级交互
- **流式优先**: 所有对话响应通过 SSE 流式推送，打字机式增量渲染，拒绝全量等待
- **前后端分离**: IDE 前端归 PolarCopilot，Agent 后端归 PolarClaw——职责清晰，可独立演进

---

## 功能介绍

- **生态位** = PolarCopilot IDE Agent 框架的前端组件，通过 PolarClaw API 调用 Agent 后端能力
- **承担功能**:

| 编号 | 功能域 | 说明 |
|---|---|---|
| E1 | 侧边栏对话面板 | WebView 聊天界面，支持用户/助手/错误三种消息样式 |
| E2 | SSE 流式通信 | 与 PolarClaw `POST /api/chat` 对接，实时接收并渲染响应分块 |
| E3 | 代码选中注入 | `PolarClaw: Send Selection to Chat` 命令，将编辑器选中文本发送至对话 |
| E4 | 配置管理 | `polarclaw.serverUrl` / `polarclaw.entryType` 两项 VSCode 设置 |
| E5 | 健康检查 | 客户端内置 `/health` 探测，确认 PolarClaw 后端可达性 |

---

## 与其他项目的关系

- **归属 PolarCopilot**: 本扩展是 PolarCopilot IDE Agent 框架的前端组件，提供 VSCode/Cursor 内的对话界面。
- **调用 PolarClaw**: 所有对话请求发往 PolarClaw `POST /api/agent/chat/stream`（默认 `http://localhost:3910`），携带 `X-Entry-Type: ide` 头。PolarClaw 负责全部 Agent 逻辑。
- **与 PolarCopilot Hub 互补**: Hub Web 模式通过 MCP 协议交互（适合 Cursor 内置 AI 对话窗口），本插件提供独立的 VSCode 侧边栏对话面板（类似 Cloud Code）。两者共存于 PolarCopilot 下，覆盖不同 IDE 交互场景。

---

## 关键设计决策

### Why WebView 而非原生 UI

VSCode 扩展的 WebView 允许完整 HTML/CSS/JS 渲染，自由度高，适合聊天界面的复杂交互（打字机效果、代码块渲染等）。但代价是无法使用 VSCode 原生组件（如 QuickPick）。当前阶段以功能验证优先，WebView 足够。

### Why SSE 而非 WebSocket

SSE 天然单向（服务端 → 客户端），与对话响应场景完全匹配。请求仍走标准 HTTP POST，兼容性更好，无需额外端口协商。WebSocket 保留给未来双向实时交互（如 Agent 主动推送通知）场景。

### Why 零后端逻辑

本扩展不持有任何密钥、不运行任何 LLM 调用。所有 AI 能力委托给 PolarClaw 后端，通过 `X-Entry-Type` 头标识入口类型。这保证了：(1) 密钥安全——密钥只存在于 PolarClaw → PolarPrivate 链路中；(2) 可独立升级——扩展 UI 变更不影响 Agent 逻辑。

### 当前局限

- WebView 中的代码块为纯文本渲染，无语法高亮（需引入 highlight.js 或类似库）
- 无对话历史持久化（刷新 WebView 后丢失）
- `userId` 硬编码为 `vscode-user`，尚未对接 PolarUser 身份体系
- 无测试框架与测试文件

---

## 依赖与被依赖

### 依赖

| 依赖项 | 接口 | 说明 |
|---|---|---|
| **PolarClaw** | `POST /api/chat` + `GET /health` | 对话请求与健康检查 |

### 被依赖

| 被依赖项 | 说明 |
|---|---|
| 暂无 | 本扩展为生态叶子节点，当前无下游项目依赖 |
