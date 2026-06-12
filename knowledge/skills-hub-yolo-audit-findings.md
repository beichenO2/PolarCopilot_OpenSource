# Skills-Hub Web 配合 & YOLO 可行性审计报告 v2

> 审计日期：2026-04-24 | Agent: solo-web-ac7b33cc

---

## 审计范围

1. **Skills 与 Hub Web 前后端配合问题** — Skills 定义的协议是否能被 Hub 后端正确承接、前端正确展现
2. **YOLO 模式可行性** — 能否真正通过多次循环达到极限目标，且在此之前不停止不中断

## 审计依据（代码路径）

| 层级 | 文件 |
|------|------|
| Skills 协议层 | `pc-principles/SKILL.md`（P0-P20 + 协议 A-G） |
| Solo 执行层 | `pc-solo-web/SKILL.md` |
| YOLO 参考层 | `pc-web-yolo/SKILL.md` |
| Hub 后端 | `hub/src/transport/http.ts`（3907 行） |
| Hub Evolution | `hub/src/evolution/routes.ts`（276 行） |
| Web 前端 API | `web/src/lib/api.ts` |
| Web SSE Hook | `web/src/lib/useUiSse.ts` |
| Web PromptsPage | `web/src/pages/PromptsPage.tsx` |
| Web YoloPage | `web/src/pages/YoloPage.tsx` |
| Web PromptCard | `web/src/components/PromptCard.tsx` |
| Web Store | `web/src/stores/hub.ts` |

---

## 一、Skills 与 Hub Web 前后端配合审计

### ✅ 配合正常的部分

| 协议/功能 | Skills 定义 | Hub 后端实现 | Web 前端实现 | 评估 |
|-----------|-------------|-------------|-------------|------|
| 协议 A：Hub 发现 | port-sdk 查端口 → MCP 验证 | `/api/health` 正常 | N/A (Agent 侧) | ✅ |
| 协议 B：注册 | `hub_register` MCP 工具 | 完整实现，含碰撞重试 | Agent 列表展示 | ✅ |
| 协议 C：Commit 流程 | `git add → commit → push → SoTADiff → 验证 → 信号` | SoTADiff MCP 工具已实现 | N/A | ✅ |
| 协议 D：SSE 等待 | `GET /api/ui/prompts/:id/stream` | 完整实现：SSE + 30s 心跳 + 自动 heartbeat | N/A (Agent 侧) | ✅ |
| 协议 E：Slave 发现 | 3 种方式 + 3-strike 死亡检测 | `/api/ui/agents/summary` + PATCH | AgentCard + batch assign | ✅ |
| 协议 F：动态命名 | `hub_set_display_name` MCP 或 PATCH | PATCH `/api/ui/agents/:id` | display_name 显示 | ✅ |
| Prompt 创建 | `POST /api/ui/prompts` 支持 choice/info/multi | 完整实现 + supersession | PromptCard 组件 | ✅ |
| Prompt 回答 | `POST /api/ui/prompts/:id/answer` | 完整实现 + SSE 通知 | 批注 + 选项 + 自由文本 | ✅ |
| SSE 全局推送 | `/api/ui/stream` for UI | 实现 `prompt_created` + `prompt_answered` | `useUiSse` hook | ✅ |
| Alignment API | YOLO 对齐文档 CRUD | 完整实现：create/list/get/patch/confirm/approve/complete/reject/versions | YoloPage 完整 UI | ✅ |
| Evolution API | signals/genes/suggestions/stats | 完整实现 + approved + execute | EvolutionPage + api.ts | ✅ |

### ⚠️ 发现的配合问题

#### [MATCH-1] P0: YoloPage 未使用 SSE，仍 3s 轮询

**Skills 定义**：协议 D 明确要求用 SSE 推送替代轮询。
**Hub 后端**：`/api/ui/stream` 已实现全局 SSE，推送 `prompt_created` 和 `prompt_answered`。
**PromptsPage**：已接入 `useUiSse`，轮询降至 10s（SSE 作为主通道）。
**YoloPage**：仍使用 `setInterval(load, 3000)` 每 3 秒轮询全部数据（alignment + prompts + history + agents），未使用 `useUiSse`。

```144:147:PolarCopilot/web/src/pages/YoloPage.tsx
  useEffect(() => {
    load()
    const iv = setInterval(load, 3000)
    return () => clearInterval(iv)
  }, [load])
```

**影响**：YoloPage 每 3 秒发 4 个 HTTP 请求，开多 tab 时 Hub 负载翻倍。

**修复**：在 YoloPage 引入 `useUiSse`，降低轮询频率到 10-15s。

---

#### [MATCH-2] P1: Alignment 状态变更无 SSE 通知

**Hub 后端**：`notifyUiSse` 只在 `prompt_created` 和 `prompt_answered` 时调用。Alignment 的 approve/complete/reject/update 操作不触发任何 SSE 事件。

**影响**：YoloPage 中对齐文档被 approve 后，前端只能等下次轮询才能感知。在 YOLO 执行阶段，Agent 通过 API 更新 alignment 状态（executing → completed），前端无法实时反映。

**修复**：在 alignment approve/complete/reject/update 操作后调用 `notifyUiSse('alignment_updated', { id, status })`。

---

#### [MATCH-3] P1: YoloPage `handleStartYolo` 缺少 SSE stream 等待

**Skills 定义**：协议 D 要求 Agent 发 prompt 后用 SSE stream 等待回答。
**YoloPage**：用户发起 YOLO 后，前端找到一个 pending prompt 并直接回答，或创建一个 alignment doc。但没有机制等待 Agent 处理这个 alignment 并生成对齐方案。

```162:184:PolarCopilot/web/src/pages/YoloPage.tsx
  const handleStartYolo = async () => {
    if (!yoloInput.trim() || sending) return
    // ...
    const activePending = pendingAll.find((p) => !p.answered)
    if (activePending) {
      await api.prompts.answer(activePending.id, `YOLO模式 ${yoloInput.trim()}`)
    } else {
      const firstAgent = agents[0]
      if (firstAgent) {
        await api.alignment.create({ ... })
      }
    }
  }
```

**影响**：当没有 pending prompt 时，前端直接创建 alignment doc 但 Agent 不知道有新的 alignment doc（没有事件通知）。Agent 必须自己轮询 alignment 列表才能发现。

**修复建议**：
1. alignment 创建后应触发 `notifyUiSse('alignment_created', ...)`
2. Agent 侧应监听 alignment 相关事件，或在 Skill 中增加 alignment 轮询逻辑

---

#### [MATCH-4] P2: `useUiSse` 无错误重连逻辑

**实现**：`useUiSse` 使用浏览器原生 `EventSource`，依赖服务端 `retry: 3000` 自动重连。但如果 Hub 重启导致 TCP 连接断开，`EventSource` 的 `onerror` 未被处理，只依赖浏览器默认行为。

```12:31:PolarCopilot/web/src/lib/useUiSse.ts
  useEffect(() => {
    const base = ...
    const es = new EventSource(`${base}/api/ui/stream`)
    // 没有 es.onerror 处理
    return () => { es.close() }
  }, [])
```

**影响**：多数现代浏览器的 EventSource 会自动重连（遵守 `retry:` 头），但如果 Hub 长时间下线再恢复，可能需要手动重连。

**风险评级**：低。浏览器原生 EventSource 自动重连通常够用。但建议添加 `onerror` 日志以便调试。

---

#### [MATCH-5] P2: DashboardPage / EvolutionPage 未接入 SSE

`useUiSse` 目前仅被 `PromptsPage` 使用。`DashboardPage`、`EvolutionPage` 完全依赖各自的 polling。

**影响**：Dashboard 显示的 Agent 存活状态、Evolution 显示的信号变化不是实时的。

---

#### [MATCH-6] P2: Hub `GET /api/ui/prompts` 列表接口的 N+1 查询

每次列出 pending prompts 时，后端对每个不同的 `agent_id` 做一次独立的 DB 查询获取 `display_name`：

```2692:2697:PolarCopilot/hub/src/transport/http.ts
      const agentIds = [...new Set(rows.map((r) => r.agentId).filter(Boolean))] as string[];
      const nameMap: Record<string, string> = {};
      for (const aid of agentIds) {
        const sess = db.select().from(sessions).where(eq(sessions.agentId, aid)).get();
        if (sess?.displayName) nameMap[aid] = sess.displayName;
      }
```

同样的模式在 `history` 和 `GET /:id` 中重复。

**影响**：有 N 个 Agent 时，列表查询变成 1+N 次 DB 操作。SQLite 单线程所以串行执行。多 Agent 高频轮询时有延迟。

**修复**：改为一次批量查询 `WHERE agentId IN (...)`。

---

#### [MATCH-7] P3: Skills 定义的 `pc-solo-web-main` (合并分支 Agent) 无对应 UI

Skills 中有 `pc-solo-web-main` 负责分支合并到 main。但 Hub Web 前端没有：
- 展示 PR/merge 请求的界面
- Agent 分支管理的可视化
- 合并操作的审核 UI

**影响**：Main Agent 的工作完全在 CLI/IDE 中完成，用户无法通过 Web UI 监控分支合并进度。

---

## 二、YOLO 模式可行性审计

### 核心问题：YOLO 能否通过多次循环达到极限目标，且中间不停止不中断？

#### 答案：**整体架构可行，有 3 个需关注的风险点**

### ✅ YOLO 不中断的设计保障

| 保障机制 | 实现位置 | 状态 |
|----------|----------|------|
| 🔒 核心不变量："Agent 没有结束概念" | `pc-solo-web` 最高优先级禁止项 | ✅ 明确定义 |
| 🔒 check_hub 无限循环 | `pc-solo-web` 协议 D | ✅ SSE stream 等待 |
| 🔒 禁止 maxRetries/timeout | `pc-solo-web` 禁止退出补充 | ✅ 明确禁止 |
| 🔒 上下文满时处理 | 写致继任者 → prompt → check_hub | ✅ 有流程 |
| 🔒 错误不导致停止 | "记录后 check_hub 等待指示" | ✅ 明确定义 |
| 工作优先级 | Debug > Test > Dev（固定不可改） | ✅ Skills + YOLO 参考文档一致 |
| Dev-Test-Debug 循环 | `pc-web-yolo` 阶段 2 伪代码 | ✅ while bugs → fix → retest |
| 进度汇报 | 信息型 Prompt（不阻塞） | ✅ Hub 实现 info-only 自动关闭 |
| 完成汇报 | 选择型 Prompt + alignment complete | ✅ Hub API 实现 |

### ✅ 多次循环的实现路径

Skills 定义的 YOLO 执行循环是嵌套的：

```
外层: while has_remaining_work()
  → implement(feature)
  → commit_and_push()
  → run_tests()
  内层: while bugs
    → fix(bug)
    → commit_and_push()
    → retest()
    → bugs.extend(new_bugs)
```

这个设计是正确的：
1. **外层循环**：遍历所有子任务，直到全部完成
2. **内层循环**：每个子任务做完后测试，bug 修完再回来，修复可能引入新 bug 也会被 catch
3. **不会无限循环**：因为 bugs 列表是有限的，修复是收敛的（同一 bug 不会被重复加入）
4. **不会停止**：外层循环终止条件是"所有 work 完成"，内层是"所有 bugs 修完"

### ⚠️ 风险点

#### [YOLO-1] P1: Cursor 上下文折叠后知识丢失风险

**现状**：Cursor Agent 上下文满了会自动折叠（不是物理上限）。
**风险**：折叠后 Agent 丢失前面子任务的细节，可能：
- 重复实现已完成的功能
- 忘记前面发现的 bug pattern
- 忘记自己做过的 commit

**Skills 应对**：`pc-solo-web` 定义了"上下文接近满时：写致继任者 → prompt card 告知用户 → check_hub"。

**评估**：
- 致继任者机制是存在的，但依赖 Agent 主动判断"上下文接近满"
- Cursor 的自动折叠是被动发生的，Agent 可能来不及写致继任者就被折叠
- **建议**：在 YOLO 执行阶段每 3 个子任务主动写一次致继任者快照（`pc-web-yolo` 已提到"每 3 个子任务评估上下文占用"）

---

#### [YOLO-2] P1: Alignment Doc 与 Agent 执行的断联

**现状**：
- Agent 通过 `/api/ui/alignment` 创建对齐文档
- 用户通过 YoloPage 审核确认
- approve 后 status 变为 `executing`
- Agent 应该检测到 status 变化后开始执行

**问题**：
1. Alignment approve 不触发 SSE 事件（[MATCH-2]），Agent 只能轮询检测
2. Skills 中**没有定义** Agent 如何检测 alignment 被 approve 的流程——`pc-web-yolo` 只说"用户确认 → 进入阶段 2"，但实际上这个"确认"是通过 Prompt 回答还是 Alignment approve？
3. 两条路径并存：
   - **路径 A（Prompt）**：Agent 发 prompt 带选项 "确认，开始 YOLO" → 用户回答 → Agent SSE 收到
   - **路径 B（Alignment）**：Agent 创建 alignment doc → 用户在 YoloPage 逐节确认 → approve → Agent ？？？

**影响**：如果用户只在 YoloPage 点 approve 而不回答 Prompt，Agent 可能不知道可以开始执行。

**修复建议**：
1. approve alignment 时自动回答 Agent 的 pending prompt（"确认，开始 YOLO"）
2. 或者 Agent 在创建 alignment 后同时发 prompt，approve 后由 Hub 后端联动回答 prompt

---

#### [YOLO-3] P2: 测试能力假设

**Skills 定义**：YOLO 要求"每完成一个子任务 → 立刻测试"，包括 CLI 测试和 Computer Use 测试。

**现实约束**：
- CLI 测试：依赖项目有测试框架（`npm test` 等），Skills 已要求"如果没有 → YOLO 对齐阶段 Agent 必须先创建测试框架"
- Computer Use 测试：需要 Cursor 的 Computer Use 能力，目前不清楚是否可用

**评估**：CLI 测试路径是可行的。Computer Use 在 `.planning/COMPUTER-USE-TESTING-DESIGN.md` 中还是设计文档状态，未见实际实现。如果 Computer Use 不可用，YOLO 的测试覆盖率会降到只有 CLI 测试。

**影响**：不会导致中断（Agent 会跳过不可用的测试），但会降低 YOLO 的质量保障。

---

### YOLO 完整生命周期验证

| 阶段 | Skills 定义 | Hub 后端 | Web 前端 | 是否闭环 |
|------|-------------|----------|----------|----------|
| 1a. 发需求收集 prompt | ✅ `pc-web-yolo` 定义 | ✅ POST /api/ui/prompts | ✅ PromptsPage | ✅ |
| 1b. 用户描述需求 | ✅ 用户回答 prompt | ✅ answer API + SSE | ✅ PromptCard | ✅ |
| 1c. Agent 生成对齐文档 | ✅ `pc-web-yolo` 定义 curl | ✅ POST /api/ui/alignment | ✅ YoloPage 展示 | ✅ |
| 1d. 用户逐节审核 | ✅ 三维对齐 | ✅ confirm-section API | ✅ Section checklist | ✅ |
| 1e. 用户编辑方案 | ✅ 修改→重新审核 | ✅ PATCH alignment + version history | ✅ 编辑器 + diff 预览 | ✅ |
| 1f. 用户批注方案 | Skills 未明确定义 | N/A | ✅ 批注 UI 完整 | ⚠️ 前端超前 |
| 1g. 用户 approve | ✅ | ✅ status→executing | ✅ "全部确认，开始 YOLO" | ⚠️ [YOLO-2] |
| 2a. Agent 执行子任务 | ✅ Dev-Test-Debug 循环 | N/A | N/A | ✅ Agent 侧 |
| 2b. 执行中进度汇报 | ✅ 信息型 Prompt | ✅ info-only 自动关闭 | ✅ History 展示 | ✅ |
| 2c. Bug 修复循环 | ✅ while bugs → fix → retest | N/A | N/A | ✅ Agent 侧 |
| 2d. 每步 commit+push | ✅ 协议 C | ✅ SoTADiff MCP | N/A | ✅ |
| 2e. Evolution 信号 | ✅ 协议 C 步骤 4 | ✅ /api/evolution/signals | ✅ EvolutionPage | ✅ |
| 3a. 完成汇报 | ✅ 选择型 Prompt | ✅ | ✅ | ✅ |
| 3b. alignment complete | ✅ `pc-web-yolo` 阶段 3 | ✅ POST .../complete | ✅ 状态显示 | ✅ |
| 3c. 批量信号提交 | ✅ `pc-web-yolo` 阶段 3 | ✅ /api/evolution/signals | ✅ | ✅ |
| 3d. 回到 check_hub | ✅ "然后回到 check_hub" | N/A | N/A | ✅ |

---

## 三、总结

### 配合问题严重性分布

| 级别 | 数量 | 描述 |
|------|------|------|
| P0 | 1 | YoloPage 未接入 SSE |
| P1 | 3 | Alignment 无 SSE 通知、YOLO approve 断联、上下文折叠风险 |
| P2 | 3 | useUiSse 无 onerror、其他页面未接入 SSE、N+1 查询 |
| P3 | 1 | pc-solo-web-main 无 UI |

### YOLO 可行性结论

**YOLO 架构设计是可行的。** Skills 定义的 Dev-Test-Debug 循环能够通过多次迭代逐步逼近极限目标。核心保障（不停止不中断）的设计是严密的：
- 禁止项明确
- SSE 等待无上限
- 错误不导致退出
- 上下文满有兜底

**最关键的修复优先级**：
1. **[YOLO-2]**：approve alignment 后如何通知 Agent 开始执行 — 这是 YOLO 能否真正跑起来的关键环节
2. **[MATCH-1]**：YoloPage 接入 SSE — 降低 Hub 负载
3. **[MATCH-2]**：Alignment 状态变更触发 SSE — 前端实时感知

---

## 五、跨项目依赖导致的功能降级 (2026-04-24 补充)

以下功能在其他项目/服务未运行时会**降级但不崩溃**：

| 依赖服务 | 端口 | 影响的功能 | 降级表现 |
|----------|------|-----------|----------|
| **PolarPrivate** | 12790 | Pilot LLM 智能分解 | 回退到 regex 行解析（功能可用但分解质量降低） |
| **PolarClaw** | 3910 | Hub PilotPage 全部功能 | Hub 代理返回空列表/502 错误 |
| **SOTAgent (port-sdk)** | 4800 | PolarClaw 启动 + Hub 端口发现 | PolarClaw 无法启动 (exit 1)；Hub 使用硬编码 3910 回退 |
| **飞书 App** | — | PolarClaw 飞书通道 | 跳过，仅 CLI/Web 可用 |
| **Clock** | 15550 | PolarClaw 主动关怀 SSE 桥 | 跳过关怀触发 |

### 启动顺序要求

```
SOTAgent (4800) → PolarPrivate (12790) → PolarClaw (3910) → Hub (PC_HUB_PORT)
```

SOTAgent 是最底层依赖：提供 port-sdk 端口注册，被 PolarClaw、Hub、KnowLever 等依赖。
PolarPrivate 是 LLM 代理：所有 LLM 调用走 PolarPrivate，否则 Pilot/Evolution 等 LLM 功能降级。

### Pilot 架构矫正 (2026-04-24)

**问题**：Pilot 原先嵌入 Hub 内部（engine.ts + store），被错误定义为 Copilot 的"下级系统"。
**矫正**：Pilot 是 PolarClaw 的子项目，与 Copilot 平级。Hub 改为代理层，/api/pilot/* 转发到 PolarClaw。
**影响**：PilotPage 在 PolarClaw 不运行时显示空列表，这是正确的分布式行为。
