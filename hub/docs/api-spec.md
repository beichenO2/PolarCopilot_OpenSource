# PolarCopilot Hub — API specification (types & schemas)

This document summarizes hub tool **names** and the **Zod modules** that define their JSON-shaped inputs and outputs. Implementations should validate at the boundary using the exported `*InputSchema` / `*OutputSchema` from `src/protocol/`.

## Phase 2 — Broadcast & planning state

| Tool (conceptual) | Protocol module | Input schema | Output schema |
|-------------------|-----------------|--------------|---------------|
| `hub_publish` | `src/protocol/broadcast.ts` | `hubPublishInputSchema` | `hubPublishOutputSchema` |
| `hub_subscribe` | `src/protocol/broadcast.ts` | `hubSubscribeInputSchema` | `hubSubscribeOutputSchema` |
| `hub_poll_events` | `src/protocol/broadcast.ts` | `hubPollEventsInputSchema` | `hubPollEventsOutputSchema` |
| `hub_state_read` | `src/protocol/state.ts` | `hubStateReadInputSchema` | `hubStateReadOutputSchema` |
| `hub_state_write` | `src/protocol/state.ts` | `hubStateWriteInputSchema` | `hubStateWriteOutputSchema` |

**Domain types:** `BroadcastEvent`, `EventSubscription`, `PlanningDocument`, `IdempotencyRecord`, `AtomicWriteResult` — `src/types.ts`.

## Phase 3 — Tasks

| Tool | Module | Input | Output |
|------|--------|-------|--------|
| `hub_create_task` | `tasks.ts` | `hubCreateTaskInputSchema` | `hubCreateTaskOutputSchema` |
| `hub_claim_task` | `tasks.ts` | `hubClaimTaskInputSchema` | `hubClaimTaskOutputSchema` |
| `hub_heartbeat_task` | `tasks.ts` | `hubHeartbeatTaskInputSchema` | `hubHeartbeatTaskOutputSchema` |
| `hub_complete_task` | `tasks.ts` | `hubCompleteTaskInputSchema` | `hubCompleteTaskOutputSchema` |
| `hub_list_tasks` | `tasks.ts` | `hubListTasksInputSchema` | `hubListTasksOutputSchema` |
| `hub_split_task` | `tasks.ts` | `hubSplitTaskInputSchema` | `hubSplitTaskOutputSchema` |

**Domain types:** `Task`, `TaskClaim`, `TaskDependency`, `TaskStatus`, `WorkflowStage` — `src/types.ts`.

## Phase 4 — Leases & configuration

| Tool | Module | Input | Output |
|------|--------|-------|--------|
| `hub_acquire_lease` | `leases.ts` | `hubAcquireLeaseInputSchema` | `hubAcquireLeaseOutputSchema` |
| `hub_release_lease` | `leases.ts` | `hubReleaseLeaseInputSchema` | `hubReleaseLeaseOutputSchema` |
| `hub_check_lease` | `leases.ts` | `hubCheckLeaseInputSchema` | `hubCheckLeaseOutputSchema` |
| `hub_get_config` | `config.ts` | `hubGetConfigInputSchema` | `hubGetConfigOutputSchema` |
| `hub_update_config` | `config.ts` | `hubUpdateConfigInputSchema` | `hubUpdateConfigOutputSchema` |

**Domain types:** `PathLease`, `InterventionMatrix`, `InterventionBehavior`, `GsdConfig`, `AutomationPreset` — `src/types.ts`.  
**Note:** `config.ts` also exports `z.infer` types that mirror the JSON config shape for convenience at call sites.

## Phase 5 — Agent loop & handoff

| Tool | Module | Input | Output |
|------|--------|-------|--------|
| `hub_checkpoint` | `agent.ts` | `hubCheckpointInputSchema` | `hubCheckpointOutputSchema` |
| `hub_handoff` | `agent.ts` | `hubHandoffInputSchema` | `hubHandoffOutputSchema` |
| `hub_request_help` | `agent.ts` | `hubRequestHelpInputSchema` | `hubRequestHelpOutputSchema` |
| `hub_report_progress` | `agent.ts` | `hubReportProgressInputSchema` | `hubReportProgressOutputSchema` |

**Domain types:** `AgentCheckpoint`, `AgentCapability`, `AgentLoopState`, `AgentLoopStatus`, `HandoffPackage` — `src/types.ts`.

## Phase 6 — Safety & observability

| Tool | Module | Input | Output |
|------|--------|-------|--------|
| `hub_set_limits` | `safety.ts` | `hubSetLimitsInputSchema` | `hubSetLimitsOutputSchema` |
| `hub_get_audit_log` | `safety.ts` | `hubGetAuditLogInputSchema` | `hubGetAuditLogOutputSchema` |
| `hub_get_health` | `safety.ts` | `hubGetHealthInputSchema` | `hubGetHealthOutputSchema` |
| `hub_get_progress` | `safety.ts` | `hubGetProgressInputSchema` | `hubGetProgressOutputSchema` |

**Domain types:** `SafetyLimits`, `AuditEntry`, `HealthStatus`, `ProgressAggregate` — `src/types.ts`.

---

## REST UI API（Web 前端 + Agent curl 使用）

以下 REST API 由 `hub/src/transport/http.ts` 实现，供 Hub Web 前端和 Agent（通过 curl）使用。

### Agents

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ui/agents` | 列出所有已注册 Agent（含 alive 状态） |
| GET | `/api/ui/agents/summary` | Agent 汇总（alive/dead/free_slaves 等） |
| PATCH | `/api/ui/agents/:id` | 更新 Agent 属性（display_name, parent_agent_id 等） |
| DELETE | `/api/ui/agents/purge` | 清理超时无心跳的 Agent |

### Prompts

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/ui/prompts` | 创建新 prompt（Agent → 用户） |
| GET | `/api/ui/prompts` | 列出 pending prompts（⚠️ 仅返回未回答的） |
| GET | `/api/ui/prompts/:id` | 查单个 prompt（无论是否已回答） |
| GET | `/api/ui/prompts/:id/stream` | SSE 等待回答（推荐，零轮询） |
| POST | `/api/ui/prompts/:id/answer` | 提交回答（用户 → Agent） |
| GET | `/api/ui/prompts/history` | 已回答的历史 prompt |

**Supersession**：同一 Agent 发送新的选择型 prompt 时，之前未回答的选择型 prompt 自动关闭（answer 设为 `[auto-closed: superseded by newer prompt]`）。

### Alignment（YOLO 对齐）

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/ui/alignment` | 创建对齐文档 |
| GET | `/api/ui/alignment` | 列出对齐文档（支持 ?agent_id 过滤） |
| GET | `/api/ui/alignment/:id` | 获取单个对齐文档 |
| PATCH | `/api/ui/alignment/:id` | 更新对齐文档字段 |
| POST | `/api/ui/alignment/:id/confirm-section` | 确认对齐文档的某一节 |
| POST | `/api/ui/alignment/:id/approve` | 批准对齐文档（status → executing） |
| POST | `/api/ui/alignment/:id/reject` | 拒绝对齐文档 |
| POST | `/api/ui/alignment/:id/complete` | 标记执行完成（status → completed） |
| GET | `/api/ui/alignment/:id/versions` | 获取版本历史 |

### Project & SSoT

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ui/project` | 获取项目信息 |
| GET/POST | `/api/ui/ssot/annotations` | SSoT 批注管理 |

### Redirect Map

| Old Path | New Path |
|----------|----------|
| `/ui/prompts` | `/pc/prompts` |
| `/ui/project` | `/pc/` |
| `/ui/agents` | `/pc/agents` |
| `/ui/yolo` | `/pc/yolo` |

---
*MCP section generated by architecture pass; REST UI section added 2026-04-24.*
