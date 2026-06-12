# polarcop-vscode 反身性地图

> 最后更新：2026-05-18 by hw-f8155387
> 触发规则：每次 Agent 对本项目进行改动后必须同步更新本文件

---

## 代码结构

| 文件 | 职责 | 行数 |
|------|------|------|
| `src/sidebar/SidebarProvider.ts` | WebView 主面板：聊天、StepFlow、历史、批注 | 1216 |
| `src/api/client.ts` | PolarClaw 后端通信：SSE 流式 + 健康检查 | 198 |
| `src/extension.ts` | VS Code 扩展入口：激活/注册 | 107 |
| `src/utils/config.ts` | 配置读写：serverUrl / entryType | 26 |

**总代码量**：~1547 行 TypeScript

---

## 能力清单

| 能力 | 状态 | 代码位置 | 版本引入 |
|------|------|----------|----------|
| 对话面板（多会话） | ✅ done | SidebarProvider L22-600 | v0.1.0 |
| SSE 流式通信 | ✅ done | client.ts L30-150 | v0.1.0 |
| 代码选中注入 | ✅ done | extension.ts polarcop.sendSelection | v0.1.0 |
| 配置管理 | ✅ done | config.ts 全部 | v0.1.0 |
| 健康检查 | ✅ done | client.ts healthCheck() | v0.1.0 |
| 文本批注 | ✅ done | SidebarProvider L679-757 | v0.2.0 |
| StepFlow v2 分层面板 | ✅ done | SidebarProvider L900-1100 | v0.3.8 |
| 后端对话历史加载 | ✅ done | SidebarProvider _loadBackend* | v0.3.8 |

---

## SSoT 状态

- **polaris.json 路径**：`polarcop-vscode/polaris.json`
- **所有 E1 功能**：`status: done`，`test_status: not_tested`
- **E2 (StepFlow v2)**：`status: done`，`test_status: not_tested`
- **版本**：0.3.8

---

## 已知局限

1. **零测试覆盖**：`src/__tests__/` 目录不存在
2. **renderMarkdown**：手写正则，不支持表格和水平分隔线
3. **SSE onChunk**：仅 `done` 事件触发，非真正增量流文本
4. **StepFlow**：展示基于事件，不支持点击跳转到源代码
5. **历史管理**：后端 API 依赖 PolarClaw 运行

---

## 构建与发布

```bash
npm install          # 安装依赖
npm run watch        # 开发模式（F5 调试）
npm run package      # 构建 .vsix
```

当前 VSIX 版本：`polarcop-vscode-0.3.8.vsix`

---

## 依赖关系

- **运行时依赖**：PolarClaw 后端 (`POST /api/agent/chat/stream` + `GET /api/status`)
- **构建依赖**：`@types/vscode >=1.85.0`、TypeScript 5.3

---

## 关键决策记录

| 日期 | 决策 | 原因 |
|------|------|------|
| 2026-05-18 | 回档 Git-branch UI，改用 StepFlow v2 | 用户反馈 Git 分支交互风格不适合展示执行逻辑 |
| 2026-05-18 | 加入后端历史管理 | 支持跨设备对话同步 |
| 2026-05-18 | EngineError + ErrorBoundary | 防止 pilot engine 未捕获异常崩溃 |
