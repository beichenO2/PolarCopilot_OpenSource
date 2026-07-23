# XJ 通用 Agent 编队设计

## 目标

XJ 新会话使用不带专业倾向的“通用 Agent”身份。HUB 创建主会话时同步创建两个固定子 Agent，并为三个 Agent 分别生成稳定 `launchId`、`sessionId` 和可复制启动 Prompt。

## 会话模型

- 主 Agent：`name=通用 Agent`、`role=general-purpose`、`agentSlot=main`。
- 子 Agent：`name=子 Agent 1/2`、`role=general-purpose`、`agentSlot=subagent-1/2`，通过 `parentSessionId` 归属于主会话。
- 会话列表仍来自同一本地文件存储；Web 将顶层会话与两个子会话分组展示。
- 同一主 `launchId` 重复创建时复用现有编队，不重复生成子 Agent。

## MCP 契约

- `register_session` 公开 schema 只暴露原生 camelCase 参数，并要求 `launchId` 与 `name`；不再暴露 `client_key`，从源头消除模型映射歧义。
- 旧 `client_key` 调用迁至独立 `register_legacy_session`，不污染正常启动 schema。
- 主 Agent 可调用 `list_subagents` 查询两个关联会话，并用 `dispatch_subagent_task` 将任务写入指定子 Agent inbox。
- 子 Agent 的任务回复自动作为 `[XJ_MSG · AGENT_RESULT]` 写回主 Agent inbox，主 Agent 下一次 `wait_message` 可直接收到。

## Web 交互

- 点击“＋”只创建一个主编队，返回主会话与两个子会话。
- 右栏新增“Agent 编队”区，显示三张紧凑卡片、状态、ID 和独立“复制启动 Prompt”按钮。
- 主 Prompt 包含 `list_subagents` / `dispatch_subagent_task` 协作规则；子 Prompt 只要求接收任务、上报进度和回复结果。
- 保持现有暗色工业控制台风格、三栏布局和状态色，不引入新的视觉体系。

## 验收

- 真实 `listTools` 中 `register_session.required` 包含 `launchId`、`name`，properties 不含 `client_key`。
- Web 创建一次得到 1 主 + 2 子，重复请求仍是同一组。
- 主派发任务后子 `wait_message` 收到；子回复后主 `wait_message` 收到 Agent Result。
- 三个启动 Prompt 均可单独复制，且不再出现“资深全栈架构师”或 `fullstack-architect`。

