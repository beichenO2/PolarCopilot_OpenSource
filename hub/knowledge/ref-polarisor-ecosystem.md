# Polarisor 生态规则

> 本文件包含 **Polarisor 多项目生态** 的协调规则（SOTAgent、端口、字典、跨设备、经验管理）。
> 这些规则不是 PolarCopilot Hub 本身的核心规则，而是在 Polarisor 环境中部署 PolarCopilot 时的附加约束。
> PolarCopilot 核心规则 → 见 `pc-principles/SKILL.md`（P0-P20 + 协议 A-G）。

---

## 1. 进程管理规范

**后台运行 = 进程完全脱离终端/IDE 会话，关闭终端后仍继续运行。**

| 场景 | 正确做法 |
|------|---------|
| 需要服务"一直运行" | 注册到 SOTAgent → `curl -X POST http://127.0.0.1:4880/api/services/<id>/start` |
| 当前会话内调试 | Shell 直接运行（知道关终端就停） |
| 禁止 | `nohup`、`&`、`disown`、`setsid` — 产生不可追踪的野生进程 |

详见 `ref-persistent-deployment.md`。

### Agent 生命周期管理（SOTAgent 挂号/销号）

1. **挂号**（Agent 启动时）：`POST /api/agent/register { deviceId, sessionId, taskDescription }`
2. **心跳刷新**（每次任务开始时）：`POST /api/agent/heartbeat { sessionId }`
3. **销号**（Agent 结束时）：`POST /api/agent/deregister { sessionId }`

---

## 2. 跨设备协调签到（YOU 工作区）

SOTAgent 的 `you/` 目录是跨设备协调工作区，每台设备一个 `.md` 文件。

同步方式：

```bash
cd ~/Polarisor/SOTAgent
git add you/
git commit -m "you: 更新工作状态 — [简述]"
git push origin HEAD
```

---

## 3. 跨设备问题排查协议（先读后查）

发现异常时，**禁止直接检查和修复**。强制流程：

1. 读 `致继任者/接手文档.md` + `致继任者/进度.md`
2. 读 `~/Polarisor/SOTAgent/you/{对端设备}.md`
3. 确认是**意外故障**还是**有意变更**后再行动

---

## 4. 收件箱检查

Agent 每次 session 开始时读取 `~/Polarisor/SOTAgent/you/` 目录下的对端设备文件，检查新消息。

---

## 5. 项目字典（跨项目感知）

- **源目录**: `~/Polarisor/SOTAgent/项目字典/`
- **各项目访问**: `<项目根目录>/项目字典/`（软链接）
- **机器可读索引**: `项目字典/_index.json`

---

## 6. 端口 SDK 规范（port-sdk-mandatory）

**所有 Polarisor 服务必须通过 port-sdk 向 SOTAgent 注册端口，禁止硬编码。**

### 服务端（启动时申请端口）

```javascript
// Node.js (CJS)
const { claimPort } = require('{workspace}/PolarPort/src/sdk/index.cjs');
const port = await claimPort({ service: 'my-service', project: 'MyProject', preferred: 3000 });
```

```python
# Python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'PolarPort', 'src', 'sdk', 'python'))
from polarisor_port_sdk import claim_port_sync
port = claim_port_sync(service="my-service", project="MyProject", preferred=8000)
```

### 客户端（连接其他服务）

推荐程度递减：

1. **网关模式**（推荐）：`http://127.0.0.1:4800/gw/<prefix>/<path>`
2. **SDK 查询**：`const port = await getPort('service-name')` → `http://127.0.0.1:${port}/...`
3. **discoverService**：一次性获取 gatewayUrl + directUrl

| 网关前缀 | 后端服务 | preferred |
|----------|---------|-----------|
| `polarprivate` | PolarPrivate Backend | 12790 |
| `digist` | DiGist API | 3800 |
| `knowlever` | KnowLever RAG API | 8000 |
| `autooffice` | AutoOffice | 3900 |
| `clock` | PolarClock Backend | 15550 |
| `polarcop` | PolarCopilot Hub | 8765 |

### 禁止

- ⛔ 硬编码端口号连接其他服务（如 `fetch('http://127.0.0.1:3800/...')`）
- ⛔ try/catch port-sdk 然后 fallback 到硬编码端口
- ⛔ 绕过 SOTAgent 直接写端口注册表

### PolarClaw 技能共享模块

PolarClaw 技能统一使用 `skills/_shared/port-discovery.ts` 发现端口：
```typescript
import { getServiceUrl, SERVICES } from '../_shared/port-discovery.js';
const base = await getServiceUrl(SERVICES.DIGIST.name, SERVICES.DIGIST.gateway);
```

---

## 7. SOTAgent 通信弹性

SOTAgent 是基础设施层。port-sdk 规定：**SOTAgent 不可达时服务必须 crash**。
- 这保证了端口注册表始终是 single source of truth
- 如果 SOTAgent 宕机，所有服务重启后自动重新注册

---

## 8. 同步排除与构建规范

`.gitignore` 必须包含 `node_modules/`、`dist/`、`.DS_Store` 等。
PeerSync 拉取新 commit 后自动检测依赖变化并重建。

---

## 9. 经验总结管理

每个项目有 `经验总结/` 文件夹，存放可复用知识。创建后向 SOTAgent 发送备案消息。
查询走本地索引文件（`~/.sotagent/lessons-index.json`），SOTAgent 离线不影响。

---

## 10. 新项目接入 Polarisor 生态

### 10.1 设计理念

**SOTAgent 是项目生命周期的入口。** 新项目不应手动逐步搭建——SOTAgent 的建项 API 负责执行全部初始化，确保每个项目以一致的骨架结构进入生态。

原则：
- **一次调用，完整骨架**：SOTAgent 建项时自动完成下表所有步骤，Agent/用户不需手动 `ln -sf`
- **声明式而非过程式**：项目描述自身需要什么（端口、服务类型、PolarCopilot 支持），SOTAgent 推导初始化动作
- **可扩展**：未来新增的生态能力（如 CI 模板、部署配置、MCP 服务注册）只需在 SOTAgent 建项流程中追加步骤，所有项目自动受益
- **幂等安全**：对已存在的项目重跑初始化不会破坏现有内容（已有链接跳过、已有目录保留）

### 10.2 初始化 Checklist（SOTAgent 自动执行）

以下步骤由 SOTAgent 建项 API 按顺序执行：

| # | 步骤 | 自动化方式 | 备注 |
|---|------|-----------|------|
| 1 | `git init` + `.gitignore` | SOTAgent 模板 | node_modules/、.env、.DS_Store、项目字典 |
| 2 | 链接 Cursor Rules | `ln -sf ~/Polarisor/gsd-2/.cursor/rules <项目>/.cursor/rules` | PolarCopilot 全局规则，所有项目共享 |
| 3 | 创建 `致继任者/` | SOTAgent 生成骨架 | 接手文档.md、进度.md、需求对齐.md、相关项目.md |
| 4 | 创建项目字典软链接 | `ln -sf ~/Polarisor/SOTAgent/项目字典 <项目>/项目字典` | 跨项目感知 |
| 5 | GitHub 私有仓库 | `gh repo create <name> --private --source=. --push` | 可选，按项目配置 |
| 6 | SOTAgent 注册 | `POST /api/services` | 自动发现或显式注册 |
| 7 | 端口申请 | `POST /api/ports/allocate` | 仅需端口时 |
| 8 | PolarCopilot `.planning/` | 初始化 PROJECT.md + ROADMAP.md | 仅 PolarCopilot 项目 |

### 10.3 Symlink 分层说明

| 链接类型 | 频率 | 指向 | 作用 |
|----------|------|------|------|
| **Skills 全局** | 自动同步（`sync-skills.sh`） | `~/.codex/skills/pc-*` → PolarCopilot Skills | 所有 Cursor 窗口可用 `$pc-*` |
| **Rules 项目级** | 每项目一次 | `<项目>/.cursor/rules` → `~/Polarisor/gsd-2/.cursor/rules` | 项目自动加载文件级规则 |
| **项目字典** | 每项目一次 | `<项目>/项目字典` → `~/Polarisor/SOTAgent/项目字典` | 跨项目知识共享 |

Skills 链接由 `gsd-2/scripts/sync-skills.sh` 自动管理：
- `bash scripts/sync-skills.sh` — 扫描源目录，创建缺失链接，删除孤立链接
- `bash scripts/sync-skills.sh --verify` — 仅校验，不修改（退出码 1 = 有问题）
- `bash scripts/sync-skills.sh --dry-run` — 预览变更
- 自动集成：`deploy-and-restart.sh` 前置检查阶段自动调用

Rules 和项目字典链接由 SOTAgent 建项自动完成。

### 10.4 扩展预留

SOTAgent 建项流程的未来扩展点（当前不实现，仅记录意图）：
- CI/CD 模板初始化（GitHub Actions / 本地 hook）
- MCP 服务自动注册（项目级 MCP server 声明）
- 开发环境检测与配置（Node/Python/Rust 版本 + 依赖安装）
- 项目间依赖图更新（`~/.polarcop/coordination/dependencies/`）

---

## 11. 生态元数据仓库（_Polarisor）

**`~/Polarisor/_Polarisor/`** 是 Polarisor 生态的元数据仓库（独立 git 仓库），存放跨项目的基础设施信息和设计文档。

| 文件 | 用途 | Agent 应参考的场景 |
|------|------|-------------------|
| `infrastructure.md` | 设备清单、端口注册表、Tailscale 配置 | 需要连接其他设备或查端口分配时 |
| `projects.md` | 所有项目清单和状态 | 需要了解生态全貌时 |
| `dependency-map.md` | 项目间依赖关系 | 修改可能影响其他项目时 |
| `status.md` | 生态运行状态 | 诊断跨项目问题时 |
| `capability-ecosystem-design.md` | 能力生态设计文档 | 理解系统架构时 |
| `port-sdk-design.md` | 端口治理 SDK 设计 | 涉及端口分配时 |
| `structure-*.md` | 两台设备文件系统结构 | 定位文件或服务时 |
| `error-envelope/` | 统一错误格式规范 | 设计 API 错误返回时 |
| `shared-rules/` | 跨项目共享规则 | 编写跨项目约束时 |

**与 .planning/ 的区别**：
- `.planning/` = 单个项目内部的功能设计
- `_Polarisor/` = Polarisor 整体生态的跨项目元数据
