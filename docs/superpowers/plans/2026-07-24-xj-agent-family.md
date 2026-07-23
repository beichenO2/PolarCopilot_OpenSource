# XJ Agent Family Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 XJ 默认身份改为通用 Agent，修正 `register_session` schema，并为每个主会话自动创建两个可协作子 Agent。

**Architecture:** 在现有 `XjFileStore` 会话记录上增加父子关系与 slot，Router 负责幂等创建 1+2 编队，MCP 增加查询和派发工具，子 Agent 回复由 Store 可靠回流主 inbox。React 页面只消费会话关系并生成三个独立启动 Prompt。

**Tech Stack:** TypeScript、Node.js、MCP SDK、Express、React、Vitest、本地原子 JSON 文件队列。

---

### Task 1: 锁定 schema 与中性 Prompt 契约

**Files:**
- Modify: `hub/tests/xj/mcp-server.test.ts`
- Modify: `web/src/lib/__tests__/xj.test.ts`
- Modify: `hub/src/xj/mcp-server.ts`
- Modify: `web/src/lib/xj.ts`

- [ ] **Step 1: 写失败测试**：断言 `register_session` schema 必填 `launchId/name` 且不含 `client_key`；Prompt 使用“通用 Agent/general-purpose”并明确禁止映射为 `client_key`。
- [ ] **Step 2: 运行测试确认 RED**：`npm test -- --run tests/xj/mcp-server.test.ts` 与 `npm test -- --run src/lib/__tests__/xj.test.ts`。
- [ ] **Step 3: 最小实现**：将旧注册入口拆到 `register_legacy_session`，更新 Prompt 生成器。
- [ ] **Step 4: 运行测试确认 GREEN**。

### Task 2: 实现 1 主 2 子的持久化编队

**Files:**
- Modify: `hub/tests/xj/store.test.ts`
- Modify: `hub/tests/xj/router.test.ts`
- Modify: `hub/src/xj/types.ts`
- Modify: `hub/src/xj/store.ts`
- Modify: `hub/src/xj/router.ts`

- [ ] **Step 1: 写失败测试**：覆盖父子字段、固定两个子会话、重复创建去重、列出子 Agent。
- [ ] **Step 2: 运行测试确认 RED**。
- [ ] **Step 3: 最小实现**：增加 `parentSessionId/agentSlot`，实现 `ensureSessionFamily` 与 `listSubagents`。
- [ ] **Step 4: 运行测试确认 GREEN**。

### Task 3: 实现主子任务闭环

**Files:**
- Modify: `hub/tests/xj/store.test.ts`
- Modify: `hub/tests/xj/mcp-server.test.ts`
- Modify: `hub/src/xj/store.ts`
- Modify: `hub/src/xj/mcp-server.ts`

- [ ] **Step 1: 写失败测试**：主派发后子 wait 收到任务；子 reply 后主 wait 收到带 taskId/subagentId 的 Agent Result。
- [ ] **Step 2: 运行测试确认 RED**。
- [ ] **Step 3: 最小实现**：增加 `dispatchSubagentTask`，在子回复确认 claim 前读取任务元数据并回流主 inbox。
- [ ] **Step 4: 运行测试确认 GREEN**。

### Task 4: 增加编队 UI 与三个复制按钮

**Files:**
- Modify: `web/src/types/xj.ts`
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/pages/XjPage.tsx`

- [ ] **Step 1: 扩展已存在的 Prompt/helper 测试，固定主子 Prompt 差异与中性身份**。
- [ ] **Step 2: 更新 API 类型与创建请求 `subagent_count: 2`**。
- [ ] **Step 3: 在左栏分组子会话，在右栏添加三张编队卡片及复制反馈**。
- [ ] **Step 4: 运行 Web 测试与生产构建**。

### Task 5: 配置刷新与真实闭环验收

**Files:**
- Modify: `scripts/install-xj-mcp.mjs`
- Modify: `polaris.json`

- [ ] **Step 1: 为 MCP 配置写入 schema 版本环境变量，使 Cursor 检测到配置变化并重建 stdio client**。
- [ ] **Step 2: 运行安装与 `--verify`，再用真实 stdio `listTools` 检查 schema**。
- [ ] **Step 3: 通过 PolarProcess 重启 `polarcop-hub`，真实创建编队、派发、子回复、主回收**。
- [ ] **Step 4: 运行 XJ、Web、TypeScript、构建与运行时治理审计，更新 SSoT 证据**。

