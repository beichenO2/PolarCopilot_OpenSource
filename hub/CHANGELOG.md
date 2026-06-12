# Changelog

## v0.6.0 (2026-04-10)

### New Features
- **IDE-Only 模式**（`$gsd2-first-proxy`）：所有 Agent 在 IDE Agent 窗口中运行，用户可直接观察每个 Agent
  - 架构：1 First-Proxy + M Proxy + NM 子 Agent（1+M+NM）
  - `src/roles/ide-bootstrap-header.template.md`：IDE 引导头，包在角色模板外面处理 check 循环和动态角色分配
  - `scripts/generate-ide-prompts.sh`：为每个项目生成 IDE prompt 文件（复用现有 `.template.md`）
  - 3 个全局 Cursor Skills：`gsd2-first-proxy`、`gsd2-proxy`、`gsd2-agent`
  - Hub 通信协议完全复用 CLI 模式（同一个 Hub、同一套 hub-call.sh）
  - 同步机制：START-SIGNAL.json + Hub `ide_start_signal` 消息
  - 角色动态分配：子 Agent 启动时不知道自己的角色，由 Proxy 通过 Hub `role_assign` 消息运行时分配

### Changes
- `gsd2-multi-agent` skill 更新：增加 IDE 模式入口引导
- `gsd2` 项目 skill 更新：增加 IDE 模式触发条件和执行步骤
- `ARCHITECTURE.md`：新增 §12 IDE-Only 模式文档
- `README.md`：新增 IDE-Only 模式使用说明

---

## v0.5.2 (2026-04-10)

### Breaking Changes
- **per-agent 独立启动脚本**：废弃共用 `launcher.sh` + 参数传递模式。
  每个 agent 现在有自己的 `start-<agent-id>.sh`，所有路径在生成时硬编码。
  这彻底解决了路径包含空格（如 macOS `Mobile Documents`）导致 tmux session 瞬间崩溃的问题。

### New Features
- **三层行为观测体系**（`docs/observability.md`）
  - L1: 被动心跳（已有）
  - L2: 主动行为汇报 — 每个角色在循环末尾向 Hub 发结构化行为日志
    - Worker: `worker_activity` (action: task_done/file_edit/test_run/...)
    - Controller: `ctrl_activity` (action: poll_cycle/tasks_created/...)
    - Supervisor: `super_activity` (action: review_cycle/quality_issue/...)
  - L3: 外部行为观测 — `scripts/observe-agents.sh` 定时扫描 tmux pane buffer
- **`observe-agents.sh`**：独立观测脚本，扫描所有 agent 的 tmux pane 输出，分类行为，写入 `.planning/obs/<agent-id>.json`
- **Proxy 守望循环 STEP 2.5**：集成外部观测数据读取，可发现 IDLE/ERROR/DEAD 状态的 agent
- **CLI 对话行为诊断实验方案**：3 个实验确认 `cursor agent --print` 的 session 管理行为

### Changes
- `launch-cluster.sh`: 新增 `generate_agent_script()` 函数，为每个 agent 生成独立启动脚本
- `launch-cluster.sh`: 所有 tmux 启动命令改为引用独立脚本（`bash '${PROMPT_DIR}/start-*.sh'`）
- `worker-prompt.template.md`: 步骤 2.5 增加行为汇报（`hub_publish` worker_activity）
- `controller-prompt.template.md`: 步骤 2.5 增加行为汇报（`hub_publish` ctrl_activity）
- `supervisor-prompt.template.md`: 步骤 2.4 增加行为汇报（`hub_publish` super_activity）
- `proxy-prompt.template.md`: 守望循环增加 STEP 2.5 外部观测
- `ARCHITECTURE.md`: 新增 §10 启动脚本规范、§11 行为观测体系

---

## v0.5.1 (2026-04-10)

### Fixes
- **launcher 指数退避**: `while true` 重启循环增加指数退避机制
  - 正常退出(>2min): 重置等待为 5s
  - 异常快速退出(<2min): 等待时间翻倍，最大 5 分钟
  - 60s 内超过 10 次重启: 强制休眠 5 分钟
  - 每次重启写入 `.planning/agent-state/<agent>.json` 状态文件
- **Agent 重复创建保护**: proxy-prompt.template.md Stage 3 增加启动前检查
  - 检查 tmux session 是否已存在
  - 检查 `.planning/agent-state/launched.json` 启动标记
  - 已有 Agent 运行时跳过创建阶段
- **hub-call.sh 超时设置**: curl 调用增加 `--connect-timeout 5` 和 `--max-time 30`
  - 防止网络不稳定时 curl 永远挂起
- **CLI Agent 循环强化**: 所有 CLI agent prompt 模板重写生命周期规则
  - 明确"你的下一个动作永远是调用 Shell 工具"
  - 具体的 sleep + 继续 poll 步骤
  - 强调 Agent 是常驻服务而非一次性脚本

### Changes
- `launch-cluster.sh`: 新增 standby agents 自动创建（NUM_WORKERS/5，最少2最多10个备用）
- `launch-cluster.sh`: standby agents 自动分配 reserve 角色，修复 CLK succession "no reserves" 问题
- `launch-cluster.sh`: launcher.sh 模板改用 heredoc + sed 占位符替换（解决引号嵌套问题）
- `launch-cluster.sh`: 重启时附加恢复上下文（跳过初始化步骤）
- `proxy-prompt.template.md`: launcher 模板改为带指数退避版本
- `controller-prompt.template.md`: 生命周期规则重写 + 任务完成处理 + 错误处理策略
- `supervisor-prompt.template.md`: 生命周期规则重写
- `worker-prompt.template.md`: 生命周期规则重写
- `partition-ctrl-prompt.template.md`: 生命周期规则重写
- `prompts.ts`: work loop 指令强化，增加 NEVER EXIT 标注 + globalClkPrompt + standbyPrompt 强化
- `cluster-status.sh`: 增加 Agent 重启状态面板
- `run-phase.sh`: 迁移到项目隔离前缀
- `launch-system.sh`: 标记为已废弃，重定向到 launch-cluster.sh
- `launcher.ts`: 修复硬编码 gsd2- 前缀为项目隔离前缀
- `ARCHITECTURE.md`: 更新核心原则和工作循环描述（反映指数退避 + 双层保障）
- `package.json`: 版本更新到 0.5.1
- 新增 `global-clk-prompt.template.md`: 全局时钟跨项目协调 prompt 模板
- `.planning/BUG-REPORT.md`: 详细的 6 个 bug 根因分析和修复记录
- `.planning/RESEARCH.md`: agent-file, OWL, Sim Studio 调研报告

---

## v0.5.0 (2026-04-09)

### Features
- **全局资源规划**: 接最后一棒的代理Agent统一规划所有项目的Agent资源
  - `hub_system_resources` 工具：获取 CPU/内存使用率，计算可开 Agent 上限
  - CPU + 内存总占用不超过 90%
  - 跨项目需求汇总：`~/.gsd2/pending-configs/<hash>.json`
  - 资源方案需用户确认后才执行
- **质量劣化检测（内部监督）**: 对接工作的 Agent 监督同伴输出质量
  - `hub_report_degradation` 工具：上报异常（俄语/韩语输出、幻觉、质量骤降）
  - severity: `warning`（记录备查）或 `critical`（立即换人）
  - critical 级别自动触发从全局备用池继任
- **全局冗余池**: 备用 Agent 不按项目分，全局共享
  - 哪个项目有需求就从全局池中划出
  - 可用 Agent 越来越少时工作范围自然收窄
- **临界停止机制**: 当项目只剩 1 个可用 Agent 时
  - 停止工作，写 HANDOFF.md 落盘，结束任务
  - 这是唯一的停止工作方式
- **大 payload 支持**: Express body-parser 限制从 100KB 提升到 10MB
  - 修复大任务描述导致 PayloadTooLargeError 的 bug
- **MODEL_FLAG 修复**: auto 模式下显式传递代理检测到的模型ID
  - 不再"不传 --model"，而是始终写入 resolved_model

### Changes
- `ARCHITECTURE.md`: 新增 §5.2 质量劣化检测、§5.5 全局备用池与收窄机制、§4.3 资源规划流程
- `controller-prompt.template.md`: 新增内部监督和收窄停止规则
- `supervisor-prompt.template.md`: 新增质量劣化检测职责
- `worker-prompt.template.md`: 新增临界停止条件
- `proxy-prompt.template.md`: 新增资源规划确认流程、resolved_model 字段
- `launch-cluster.sh`: 始终传 --model，移除 auto 不传逻辑
- `transport/http.ts`: 新增 hub_report_degradation、hub_system_resources 工具；body limit 10MB

### Tests
- 新增 `tests/e2e/stress.test.ts`: 6 个压力测试
  - 20 轮快速对话验证无异常
  - 100KB+ 大 payload 自愈验证（compressPayload 截断）
  - 50KB 大任务描述不崩溃
  - 50 条连续事件无数据丢失
  - 断连重连后数据持久化验证
  - 10 次快速重连无 session 损坏

---

## v0.4.0 (2026-04-09)

### Features
- **单机/集群模式选择**: 启动时用 AskQuestion 问用户选择 Solo 或 Cluster 模式
  - 单机模式：代理自己干所有活，绝对不启动子 Agent（除非用户明确说"可以开 N 个"）
  - 集群模式：完整多 Agent 协作
  - 配置持久化到 `.planning/mode.json`
- **CLI 账号验证**: 每次启动前检测 CLI 登录账号，用 AskQuestion 问用户是否与 IDE 账号一致
  - 支持在代理中直接执行 logout/login 切换账号
  - 用户可提前声明"不用重新登录"跳过此步骤
- **模型配置**: 子 Agent 模型可由用户指定
  - 默认 `auto`（代理检测自身模型ID，写入 `resolved_model`，所有子Agent继承）
  - 可指定具体模型 ID（如 `claude-4.6-opus-high`），通过 `--model` 参数传递
  - **始终显式传递 `--model`**：auto 不是"不指定"，而是"继承代理的模型"
- **`launch-cluster.sh --model <id>`**: 集群启动脚本支持 `--model` 参数
  - 模型 ID 写入 launcher.sh 的 `GSD_AGENT_MODEL` 环境变量
  - 始终传 `--model $GSD_AGENT_MODEL`，无论 auto 还是手动指定

### Changes
- `proxy-prompt.template.md`: 新增前置检查流程（P1 账号验证、P2 模式选择、P3 模型配置）
- `proxy-prompt.template.md`: 核心规则拆分为通用/集群/单机三部分
- `proxy-prompt.template.md`: 阶段3 按模式分支（3A 单机、3B 集群）
- `launch-cluster.sh`: launcher.sh 模板加入 `GSD_AGENT_MODEL` 和 `MODEL_FLAG` 逻辑
- `launch-cluster.sh`: 启动和完成 banner 显示当前模型配置

---

## v0.3.0 (2026-04-09)

### Breaking Changes
- Agent 初始化后不可关闭，一路跑到死（移除 while true 重启循环）
- 全局初始化确认机制：跨项目资源锁定
- 禁止使用 subagent / Task 工具

### Features
- **永不退出模式**: 所有角色 prompt 改为内含无限轮询循环，agent 持续运行直到 context window 耗尽自然死亡
- **全局资源锁** (`global-lock.sh`): 跨项目初始化确认 + 资源锁定
  - `register` / `confirm` / `check` / `status` / `unlock --force`
  - 所有项目确认后自动全局锁定
  - 锁定后 `launch-cluster.sh` 拒绝执行，`stop-cluster.sh` 拒绝执行（除非 `--force`）
- **备用池继任不受锁限制**: 死亡自愈不算新建 Agent
- 所有角色 prompt 添加心跳调用 (`hub_heartbeat_role`)

### Changes
- `launch-cluster.sh`: launcher.sh 模板去掉 while true 循环
- `controller-prompt.template.md`: "做完就退出" → "永不退出的无限轮询"
- `supervisor-prompt.template.md`: 同上
- `worker-prompt.template.md`: 移除"每轮最多3个任务"限制，移除所有"退出本轮"指令
- `partition-ctrl-prompt.template.md`: 添加生命周期规则和无限轮询
- `proxy-prompt.template.md`: 添加全局确认流程（阶段3.5），更新 launcher 模板
- `ARCHITECTURE.md`: 更新核心原则、工作循环描述、启动确认流程
- `REWRITE-PLAN.md`: 强化禁止 subagent 原则
- `knowledge/ref-planning-config.md`: 标注 subagent_timeout 已废弃
- `knowledge/ref-verification-patterns.md`: 标注不使用 subagent

## v0.2.0 (2026-04-09)

### Breaking Changes
- All tmux sessions now use `g-<hash>-` prefix instead of `gsd2-`
- Hub port is deterministic per-project (no longer fixed 8765)
- `tmux kill-server` is forbidden — only kill own-prefix sessions

### Features
- **Project isolation** (`lib-isolate.sh`): 4-char hash prefix + deterministic port prevents cross-project collisions
- **3-tier architecture** (`--tiered` flag): proxy → ctrl → partition controllers (5 domains) → workers
- **`partition-ctrl-prompt.template.md`**: Domain-scoped task splitting for backend/frontend/data/infra/test
- **`launch-cluster.sh`**: One-command cluster startup with prompt files, while loops, `--watchdog`, `--tiered`, batch launching
- **`stop-cluster.sh`**: Graceful shutdown with `--keep-hub`, SIGTERM before session kill
- **`cluster-status.sh`**: Dashboard showing sessions, roles, tasks (progress bar), health, system resources
- **`hub-watchdog.sh`**: Auto-detect Hub crash and restart (3 consecutive failures threshold)
- **`smoke-test.sh`**: 5-second headless pipeline verification (register→create→claim→complete)
- **`test-e2e-cluster.sh`**: Full 14-check pipeline test
- **Standardized role prompt templates** (`src/roles/`):
  - `proxy-prompt.template.md` — Full proxy bootstrap with isolation rules
  - `controller-prompt.template.md` — Task dispatch loop with event filtering
  - `supervisor-prompt.template.md` — Quality review loop
  - `worker-prompt.template.md` — Task execution with error handling
  - `partition-ctrl-prompt.template.md` — Domain partition controller

### Fixes
- `hub-call.sh`: Auto-retry (3 attempts) on session expiry, empty response, "not_registered"
- Hub API field corrections: `topic` not `channel`, `workflow_stage` not `phase`, `result_summary` not `result`
- Topic naming: `ctrl.inbox` (matches agent_id, not role name)
- `conda deactivate` before Hub start — prevents Node.js version mismatch in tmux
- `--trust` flag for cursor agent to skip workspace trust prompts
- Cursor agent `--print` mode documented as one-shot (needs while loop wrapper)

## v0.1.0 (2026-04-08)

### Features
- MCP Hub with Streamable HTTP transport
- SQLite persistence (WAL + synchronous=FULL for crash safety)
- Session management with stable agent_id binding
- Broadcast system (SSE push + poll fallback)
- Task model with DAG dependencies, leases, split/autocomplete
- Path leases for concurrent file edit coordination
- Configuration system with intervention matrix and presets
- Agent loop protocol with checkpoints and handoff
- Safety limits and observability (audit log, health, progress)
- 38 v1 requirements implemented across 6 phases
- 14 test files, 65 tests passing
