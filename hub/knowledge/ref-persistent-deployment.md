# 常态化部署规范 (Persistent Deployment)

macOS 上需要后台常驻的服务，**统一由 SOTAgent 管理**。

> 2026-04-14 重大变更：所有服务从独立 launchd plist 迁移到 SOTAgent ProcessManager 统一管理。

---

## "后台运行"的正确含义

**后台运行 = 进程不依赖任何终端、IDE 会话、SSH 连接。** 关闭终端/IDE/SSH 后进程继续运行。

### 为什么 Agent 在 Shell 里启动的服务会随会话关闭而停止

| 启动方式 | 关闭终端后 | 原因 |
|---------|-----------|------|
| Cursor Shell `npm run dev` | ❌ 进程被杀 | 进程是 Shell 的子进程，收到 SIGHUP 信号 |
| `nohup npm run dev &` | ✅ 存活 | nohup 忽略 SIGHUP，但**被禁止使用** |
| SOTAgent `POST /api/services/.../start` | ✅ 存活 | `detached: true` + `child.unref()` 脱离父进程 |
| launchd plist | ✅ 存活 | 系统级守护进程管理器 |

### 正确的后台运行方式

1. **通过 SOTAgent API 启动**（推荐）：
   ```bash
   curl -X POST http://127.0.0.1:4880/api/services/<id>/start
   ```
   SOTAgent 用 `spawn('/bin/sh', ..., { detached: true })` + `child.unref()` 启动子进程，进程完全脱离 SOTAgent，即使 SOTAgent 重启也不影响已启动的服务。

2. **launchd**（仅 SOTAgent 自身使用）：
   ```bash
   launchctl load ~/Library/LaunchAgents/com.sotagent.web.plist
   ```

### Agent 必须遵守的规则

1. **需要常驻的服务** → 注册到 SOTAgent，通过 API 启动
2. **临时调试** → 可以在 Shell 里直接运行，但必须知道关闭终端就停止
3. **禁止** `nohup`/`&`/`disown`/`setsid` — 绕过 SOTAgent 的野生后台进程不可管理、不可追踪

### 关键原则

> 如果 Agent 需要一个服务"一直运行"，唯一正确的做法是确保它已注册到 SOTAgent 并通过 API 启动。
> 在 Cursor Shell 里 `npm run dev` 只适合当前会话内的临时开发调试。

---

## 架构

```
macOS launchd
  └── com.sotagent.web (唯一的 launchd 服务)
        └── SOTAgent ProcessManager (:4800)
              ├── 常驻服务 (spawn + 健康检查 + 自动重启)
              ├── Cron 定时任务 (每分钟检查 cron 表达式)
              └── PeerSync (跨设备状态感知)
```

项目**只负责写代码**，SOTAgent **负责运行所有服务**。

---

## 适用条件

满足任一条件的应用应注册到 SOTAgent：
- 提供 HTTP/WebSocket 服务
- 需要定时执行后台任务（巡检、同步、监控）
- 是其他应用的依赖
- 用户明确要求"后台运行"

---

## 部署三件套

### 1. 注册到 SOTAgent

```bash
# 常驻服务
curl -X POST http://127.0.0.1:4880/api/services \
  -H "Content-Type: application/json" \
  -d '{
    "id": "<project>-<service>",
    "name": "<Human Readable Name>",
    "command": "<启动命令，用绝对路径>",
    "work_dir": "~/<project-dir>",
    "port": <PORT>,
    "device_id": "Mac-Studio",
    "auto_start": true,
    "restart_on_failure": true,
    "max_restarts": 5,
    "health_check_url": "http://127.0.0.1:<PORT>/health"
  }'

# 定时任务（注册后在 DB 中设置 cron_schedule）
sqlite3 ~/Polarisor/SOTAgent/data/resources.sqlite \
  "UPDATE shared_services SET cron_schedule = '0 * * * *' WHERE id = '<service-id>';"
```

### 2. 日志

统一路径 `~/Library/Logs/<project>.log`。

### 3. 致继任者文档

服务信息写入项目的 `致继任者/接手文档.md`。

---

## 代码更新后重启

项目代码更新后，调用 SOTAgent API 通知重启：

```bash
# 后端服务（Python / Node.js）
curl -X POST http://127.0.0.1:4880/api/services/<service-id>/notify-update \
  -H "Content-Type: application/json" \
  -d '{"strategy": "restart"}'
```

### Vite 前端特殊处理

Vite HMR 能处理大部分代码改动（组件、样式、模块热替换），**不需要重启**。

以下情况需要完整重启：
- `vite.config.ts` 变更
- `package.json` 依赖变更（需先 `npm install`）
- `.env` 文件变更
- Tailwind / PostCSS 配置变更
- `index.html` 结构变更

```bash
# Vite 完整重启
curl -X POST http://127.0.0.1:4880/api/services/<frontend-id>/restart
```

> 所有 Vite 服务必须使用 `--strictPort` 参数，防止端口自动变更。

---

## 常用运维命令

```bash
# 查看所有服务状态
curl -s http://127.0.0.1:4880/api/services | python3 -m json.tool

# 启动/停止/重启单个服务
curl -X POST http://127.0.0.1:4880/api/services/<id>/start
curl -X POST http://127.0.0.1:4880/api/services/<id>/stop
curl -X POST http://127.0.0.1:4880/api/services/<id>/restart

# 端口冲突检测
curl -s http://127.0.0.1:4880/api/services/port-conflicts

# 重启 SOTAgent 本身
launchctl unload ~/Library/LaunchAgents/com.sotagent.web.plist
launchctl load ~/Library/LaunchAgents/com.sotagent.web.plist
```

---

## 端口冲突处理

SOTAgent 在启动服务前自动检测端口：
- **自家残留进程**（command 匹配注册的 work_dir）→ 自动 kill 后启动
- **第三方进程** → 报错，需手动处理

端口**必须固定不变**。不允许服务自动切换端口。

---

## 跨设备同步

### 代码同步

所有项目代码通过 **GitHub** 同步：
- Mac Studio：开发 + 自动 push
- MacBook Pro：git pull 获取最新代码

SOTAgent 的 PeerSync 模块定时扫描项目 git 状态，检测冲突。

### SOTAgent 自身同步

SOTAgent 源码在 `~/Polarisor/SOTAgent/`（GitHub: `beichenO2/SOTAgent`）。
两台设备通过 GitHub + PeerSync 同步源码，但 `data/` 目录（SQLite 数据库）**不同步**——每台设备维护自己的服务注册和状态。

### 服务注册同步

每台设备独立注册自己需要运行的服务。使用 `scripts/register-all-services.sh` 批量注册。
注册脚本中的 `device_id` 必须匹配当前设备的 hostname。

---

## launchd 环境注意事项

- launchd 不加载 `~/.bashrc` / `~/.zshrc`，nvm 不可用
- SOTAgent plist `PATH` 必须显式指定所有 Node 版本路径
- 子进程通过 `/bin/sh -c` 执行（不是 `sh`，因为 launchd PATH 不含 /bin）
- SSH 密钥可能不可用，git fetch 加 `ConnectTimeout=3 -o BatchMode=yes`
- native 模块 (better-sqlite3 等) 需在正确的 Node 版本下 `npm rebuild`
- 阻塞操作（如同步 execSync 做 git fetch）会卡死 HTTP 服务器，使用异步版本

---

## 设备约定

| 设备 | 角色 | 常态化部署 |
|------|------|-----------|
| Mac Studio | compute + dev | ✅ 所有常驻服务在此运行 |
| MacBook Pro | dev | ⚙️ 按需，开发时手动启动 |

通过 hostname 区分。SOTAgent config.json 的 `devices` 字段定义设备列表。

---

## 孤儿进程防治

### 问题

父进程（SOTAgent/Agent 会话）死亡后，子进程（服务）可能继续存活但无人管理：
- 吃 CPU/内存但不提供有效服务
- 占用端口阻止新实例启动
- 日志无人收集

### 现有防线

| 层级 | 机制 | 覆盖范围 |
|------|------|---------|
| L1 | SOTAgent Watchdog | 已注册的 auto_start 服务 |
| L2 | 端口冲突检测 | 启动前检查端口，自家残留自动清理 |
| L3 | 熔断器 | 连续 3 次启动失败跳闸 |
| L4 | Agent 生命周期 | 30min 无心跳自动销号 |

### 缺口

- Cursor Shell 里启动的临时进程（`npm run dev`）— 终端关闭后变孤儿
- 非 SOTAgent 管理的进程（手动启动的脚本、测试服务器）
- SOTAgent 自身崩溃时，已 detached 的子进程无人监管

### 方案：子进程心跳自毁（待评估）

**设计思路**：子进程定期检查父进程是否存活（或等待心跳），超时后自行退出。

```
父进程 (SOTAgent/shell)
  │
  ├── 每 5 分钟发一次心跳文件/信号
  │
  └── 子进程 (detached service)
        └── 每 5 分钟检查心跳
            ├── 收到 → 继续运行
            └── 30 分钟未收到 → 优雅退出
```

**实现方案对比**：

| 方案 | 工作量 | 资源开销 | 适用范围 |
|------|--------|---------|---------|
| A. 心跳文件 | 低（~50行/服务） | 极低（读文件） | 需要每个服务加 wrapper |
| B. ppid 检查 | 极低（10行 wrapper） | 极低 | 仅适用于非 detached 进程 |
| C. SOTAgent 统一巡逻 | 中（~100行） | 低（lsof 扫描） | 覆盖所有端口进程 |

**推荐方案 C**：SOTAgent 统一巡逻

不需要改每个子进程的代码。SOTAgent 的 Watchdog 循环（已有，每 30s 运行一次）增加：

1. `lsof -iTCP -sTCP:LISTEN -P -n` 扫描所有监听端口
2. 与 `port_registry` 和 `shared_services` 对比
3. 未注册的监听进程 → 记录告警
4. 监听在已注册端口但 PID 不匹配 → 标记为孤儿
5. 孤儿进程存活超过 30 分钟 → 自动 SIGTERM

**工作量估算**：~100 行 TypeScript，集成到现有 `runHealthChecks()` 循环中。
**资源开销**：每 30s 一次 `lsof` 调用，开销可忽略（<10ms）。

> **决策**：方案 C 工作量适中且不需要侵入各服务代码，推荐在下一个 SOTAgent 迭代中实现。

---

## ⛔ 禁止

- ⛔ 禁止为新服务创建独立 launchd plist（统一走 SOTAgent）
- ⛔ 禁止服务自动切换端口（必须 `--strictPort` 或等效配置）
- ⛔ 禁止在代码中 hardcode 端口（使用环境变量或配置文件）
- ⛔ 禁止跳过 SOTAgent 直接 `nohup` 或 `&` 启动后台服务
- ⛔ 禁止使用不以 0 或 5 结尾的端口号（详见 `ref-port-governance.md`）
- ⛔ 禁止自行选择端口号 — 所有端口必须通过 SOTAgent `POST /api/ports/allocate` 申请
