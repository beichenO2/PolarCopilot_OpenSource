# PolarCopilot

**在 Cursor 里开多个 Agent 对话时，用浏览器统一指挥、对齐、审计——而不是在 N 个聊天窗口里来回切换。**

PolarCopilot 是 Polarisor 生态的 **多 Agent 编排 Hub**：本地 Express 后端 + React Web UI，通过 **MCP Streamable HTTP** 与 Cursor 双向通信，用 **SSE 实时推送** 替代传统 HTTP 轮询。GitHub：[beichenO2/PolarCopilot](https://github.com/beichenO2/PolarCopilot)

---

## 安装

### Polarisor 生态（推荐）

适合已克隆 [Polarisor](https://github.com/beichenO2/Polarisor) 全栈、需要 SSoT / YOLO / 进化等完整能力的场景。

```bash
git clone https://github.com/beichenO2/Polarisor.git
cd Polarisor

# 安装 Hub 依赖并构建 Web UI
cd PolarCopilot/hub && npm install
cd ../web && npm install && npm run build

# 启动 Hub（自动发现端口，默认 8040）
bash Agent_core/scripts/solo-web-startup.sh 1
```

在 Cursor **Settings → MCP** 中启用 `hub-agent-1`（或 `project-…-hub-agent-1`）并 **Reload**。浏览器打开 `http://127.0.0.1:8040/pc/`，在 Cursor 发送 `$pc-solo-web` 进入网页控制循环。

> 精简独立版（仅 Agent 控制 + YOLO 两页）见 [PolarCopilot_Opensource](https://github.com/beichenO2/PolarCopilot) 分支/README，含 `npm run setup` 一键脚本。

### 独立安装

仅克隆本仓库即可运行 Hub + Web，不依赖 Polarisor 其他子模块。

```bash
git clone https://github.com/beichenO2/PolarCopilot.git
cd PolarCopilot

# Hub 后端
cd hub && npm install && npm start    # 默认端口 8040

# Web UI（另开终端）
cd web && npm install && npm run build
```

访问 `http://127.0.0.1:8040/pc/`。MCP 通道需配置 `~/.cursor/hub-mcp-server`（Polarisor 生态由 `Agent_core` 脚本写入 `.cursor/mcp.json`）。

**环境要求**：Node.js ≥ 22 · npm · Cursor IDE · 可选 tmux（后台保活 Hub）

---

## 设计思考

### 为什么用 MCP 通道，而不是 Agent 自己 curl 轮询 Hub？

Cursor Agent 原生支持 MCP Tool 调用。Hub 暴露 **42 个 `hub_*` 工具**（注册、任务、租约、广播、审计等），UI 侧另有 **5 个交互工具**（`setup` / `send_prompt` / `check_hub` / `patch_agent` / `hub_status`）。Agent 在 `check_hub` 处 **进程内阻塞**，直到用户在 Web 点选——语义清晰，无需自建轮询循环与超时状态机。

### 为什么用 Hub 事件代理，而不是 Agent 直连？

Agent 之间 **不直接通信**。所有 pub/sub、任务队列、YOLO 对齐、SoTADiff 审计经 Hub 路由，便于统一追踪、换人和故障隔离。100+ CLI Agent 集群（gsd-2 架构）同样依赖这一层，而不是 P2P WebSocket mesh。

### 为什么用 SSE 推送 + 15s 兜底轮询，而不是纯轮询？

Web UI 通过 **Server-Sent Events** 接收 Prompt、Agent 状态、SSoT 变更；仅在 SSE 不可用时以 **15s 间隔** 兜底刷新（YOLO / Evolution / 检修页）。相比 2s HTTP 长轮询，UI 延迟更低、Hub 负载更小。

### 为什么 YOLO 必须先对齐，而不是直接全自动？

全自动执行前须完成 **三维对齐文档**（极限目标 + 7 段结构）并在 Web **逐段审批**。未批准前 Hub 拒绝进入 execute 阶段——避免「Agent 自信跑完、方向全错」的不可逆浪费。

---

## 核心亮点

| 维度 | 数据 |
|------|------|
| **Hub Agent 槽位** | **20** 路 MCP 通道（`hub-agent-1` … `hub-agent-20`），每路绑定独立 Cursor 对话 |
| **Hub MCP 工具** | **42** 个 `hub_*` 协议工具 + **5** 个 UI 交互工具 |
| **Web 页面** | **9** 个主导航页 + Checkup Widget；路由覆盖 Dashboard / Agent 控制 / SSoT / Prolusion / YOLO / Pilot / Evolution / Start Agent / 检修历史 |
| **实时通信** | MCP Streamable HTTP + SSE；轮询仅 **15s** 兜底 |
| **持久化** | SQLite（Drizzle ORM），单 Hub 进程，无 Redis 依赖 |
| **进化基因库** | **10** 条种子基因（repair / optimize / governance），**6** 阶段进化流水线（E1–E6） |
| **Prolusion 规划** | **4** 阶段结构化编译（需求 → 方案 → 任务包 → 验收） |
| **测试** | Hub **74+** 合约测试（polaris.json 记录）；Vitest 覆盖 e2e / integration / protocol |
| **Hub 版本** | `0.5.1` · Node **≥ 22** · 默认端口 **8040** |

---

## 页面预览

> 截图位于 `screenshots/`。用 Cursor **Open Folder** 打开本仓库根目录预览 Markdown 图片。

| Dashboard | Agent 控制 |
|:---:|:---:|
| ![Dashboard](screenshots/pc-01-dashboard.png) | ![Agent Control](screenshots/pc-02-prompts.png) |

| YOLO 对齐 | 进化循环 |
|:---:|:---:|
| ![YOLO](screenshots/pc-03-yolo.png) | ![Evolution](screenshots/pc-04-evolution.png) |

| SSoT 管理 | Pilot 状态 |
|:---:|:---:|
| ![SSoT](screenshots/pc-05-ssot.png) | ![Pilot](screenshots/pc-06-pilot.png) |

| Prolusion 规划 | 检修历史 |
|:---:|:---:|
| ![Prolusion](screenshots/pc-07-prolusion.png) | ![Checkup](screenshots/pc-08-checkup.png) |

| Hub 总览 | Agent 启动器 |
|:---:|:---:|
| ![Hub](screenshots/polarcop-hub.png) | ![Start Agent](screenshots/polarcop-start-agent.png) |

---

## 架构

```
PolarCopilot/
├── hub/                    # MCP Hub 后端（Express 5 + SQLite + Drizzle）
│   ├── src/
│   │   ├── transport/      # MCP Streamable HTTP + REST API
│   │   ├── broadcast/      # SSE 推送
│   │   ├── session/        # Agent 注册与心跳
│   │   ├── tasks/          # 任务队列、租约、亲和性
│   │   ├── evolution/      # 进化基因与执行器
│   │   ├── questions/      # 阻塞式问答
│   │   ├── checkup/        # 检修事件路由
│   │   ├── pilot/          # PolarClaw Pilot API 代理
│   │   ├── protocol/       # MCP 工具 schema（tasks/leases/safety/…）
│   │   └── persistence/    # SQLite store
│   ├── static/             # Checkup Widget 构建产物
│   ├── knowledge/          # 架构与设计参考文档
│   └── tests/              # Vitest（e2e / integration / contract）
├── web/                    # React 18 SPA（Vite 6 + Tailwind 3）
│   └── src/pages/          # Dashboard · Prompts · SSoT · YOLO · …
├── polarcop-vscode/        # VS Code / Cursor 侧边栏插件（可选入口）
├── polaris.json            # 项目 SSoT（需求、功能、接口）
├── PolarSoul.md            # 设计灵魂与决策记录
└── screenshots/            # README 预览图
```

**数据流**：

```
你（浏览器） ←SSE/REST→ Hub Web（/pc/*）
                           ↑
Cursor Agent ←MCP→ ~/.cursor/hub-mcp-server ←HTTP→ hub :8040
     ×20 槽位（hub-agent-1 … 20）
```

与 **PolarCopilot_Opensource** 的区别：开源精简版含独立 `mcp-server/` 与 `pc-os-*` Skills，Web 仅 **Agent 控制 + YOLO** 两页；本仓库为 **Polarisor 全功能版**，含 SSoT、Prolusion、Evolution、Pilot 代理、Checkup、VSCode 插件等。

---

## 快速开始

```bash
# 1. 构建 Web（Hub 在同一端口 serve /pc/ 静态资源）
cd web && npm install && npm run build

# 2. 启动 Hub
cd ../hub && npm install && npm start
# 或 Polarisor 生态：bash Agent_core/scripts/solo-web-startup.sh 1

# 3. 健康检查
curl -s http://127.0.0.1:8040/api/ui/health   # 应含 "ok"

# 4. 同步 Cursor Skills（Polarisor 生态）
cd hub && npm run sync-skills
```

**典型工作流**：

1. Cursor 发送 `$pc-solo-web` → Agent 调用 MCP `setup()` 注册 Hub  
2. Agent `send_prompt` 推送带选项的问题 → Web **Agent 控制**页显示按钮  
3. 你在浏览器点选 → Agent `check_hub` 取回答案 → 继续执行  
4. 极限目标：先 `$pc-yolo-confirm` 写对齐稿 → **YOLO** 页审批 → `$pc-yolo-execute` 实施  

**常用 URL**（默认端口 8040）：

| 页面 | URL |
|------|-----|
| Dashboard | http://127.0.0.1:8040/pc/ |
| Agent 控制 | http://127.0.0.1:8040/pc/prompts |
| YOLO | http://127.0.0.1:8040/pc/yolo |
| SSoT | http://127.0.0.1:8040/pc/ssot |
| Evolution | http://127.0.0.1:8040/pc/evolution |

---

## 生态依赖

| 项目 | 角色 | 是否必须 |
|------|------|----------|
| [Agent_core](https://github.com/beichenO2/Agent_core) | 协议（PROTOCOLS.md）、`pc-*` Skills、`solo-web-startup.sh` | **必须**（全功能模式） |
| [SOTAgent](https://github.com/beichenO2/SOTAgent) / PolarPort | 端口分配与服务发现（`polarcop-hub` @ 8040） | 推荐 |
| [PolarClaw](https://github.com/beichenO2/PolarClaw) | LLM 代理；Pilot 页代理其 `/api/pilot/*` | 推荐（Pilot / LLM 能力） |
| [PolarPrivate](https://github.com/beichenO2/PolarPrivate) | 密钥不出边界 | 可选 |

---

## 延伸阅读

- 设计灵魂：[PolarSoul.md](PolarSoul.md)
- Hub 架构（100+ Agent 集群）：[hub/ARCHITECTURE.md](hub/ARCHITECTURE.md)
- Copilot vs Pilot 关系：[hub/knowledge/ref-copilot-pilot-architecture.md](hub/knowledge/ref-copilot-pilot-architecture.md)
- API 规格：[hub/docs/api-spec.md](hub/docs/api-spec.md)

---

## License

MIT License — Copyright © 2026 [beichenO2](https://github.com/beichenO2)

允许商用与修改，再分发须保留版权声明与许可全文。
