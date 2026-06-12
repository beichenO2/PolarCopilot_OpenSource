# Cursor 请求泄露分析报告

## 现象

在按次计费（或 token 计费）模式下，SOLO 会话中夹杂"几万 token"的小请求。主请求为千万级别，小请求仅几万级别。

## 根因分析

### 1. Cursor Agent 模式的请求架构

Cursor Agent 模式运行为 **agentic loop**：

```
用户消息
  → Step 1: LLM 思考 + 决定工具调用 (一个 API 请求)
  → Step 2: 工具执行 → 结果回传 → LLM 继续 (又一个 API 请求)
  → Step 3: ...
  → Step N: 最终回复
```

**每个 step 都是独立的 API 请求**，都包含完整的 system prompt + 对话历史。

### 2. "小请求"的来源

| 来源 | Token 量级 | 发生时机 |
|------|-----------|---------|
| **AskQuestion 恢复** | 3-5 万 | 用户点击 AskQuestion 选项后，Cursor 发新请求恢复执行 |
| **Context summarization** | 1-3 万 | 对话超长时 Cursor 自动摘要压缩 |
| **短 step** | 2-5 万 | Agent 决定不调用工具直接回复，或只做简单判断 |
| **Linter/Diagnostic 检查** | 1-3 万 | Cursor 后台的 LSP/linter 触发的请求 |

### 3. 当前 GSD2 的固定 Token 开销

| 组件 | 估算 tokens | 说明 |
|------|------------|------|
| Cursor 基础 system prompt | ~8,000 | 不可控 |
| 工具定义 | ~6,000 | 不可控 |
| **available_skills 列表** | **~4,500** | 80+ 个 skill 的 path+描述，可优化 |
| MCP 工具描述 | ~1,000 | 不可控 |
| **SKILL.md (attached)** | **~3,500** | 可压缩 |
| **ref-common-rules.md** | **~5,700** | 可压缩 |
| **ref-interaction-protocol.md** | **~2,000** | 可合并到 SKILL.md |
| 其他上下文 | ~1,000 | 变化 |
| **合计/step** | **~31,700** | |

15 步任务的纯 system prompt 成本：**~475,500 tokens** (约 47.5 万)

### 4. AskQuestion 的额外成本

每次 AskQuestion 交互 = 至少 1 个额外请求（约 3-5 万 tokens）。

当前 GSD2 交互协议强制"每轮末尾必须 AskQuestion"，导致：
- 任务完成报告后 AskQuestion → 用户选择 → 恢复请求 (3-5 万)
- 如果用户选"继续其他任务" → 又一轮大请求
- 一个 session 3 次 AskQuestion = 额外 ~10-15 万 tokens

## 优化方案

### A. 精简 Skill/Rules 体积（即时见效）

1. 压缩 SKILL.md：去掉冗余说明、示例、注释，保留核心规则
2. 合并 ref-*.md 到 SKILL.md：减少文件引用（Cursor 可能不会自动加载引用文件，但如果 agent 读取了就是额外开销）
3. 减少 available_skills 数量：把不常用的 skill 从 ~/.cursor/skills/ 移走

预计节省：每 step ~5,000 tokens → 15 步节省 ~75,000 tokens

### B. 减少 AskQuestion 频率

修改交互协议：
- 任务完成后**不强制** AskQuestion，直接结束当轮
- 只在真正需要决策时才 AskQuestion
- 致继任者同步等收尾工作自动完成后直接停

预计节省：每 session 减少 1-3 个小请求，约 ~50,000-150,000 tokens

### C. Web UI 替代 AskQuestion（根治方案）

用 Hub 的 HTTP/WebSocket 做轻量 Web 控制台：
- Agent 需要用户输入时 → 写 JSON 到 Hub → Web UI 展示并收集回复
- Agent 轮询 Hub 获取用户回复 → 在**同一个 step** 内继续
- 消除 AskQuestion 产生的额外请求

实现路径：
1. Hub 增加 `/api/interaction` endpoint（prompt + options → 等待回复）
2. 简单前端页面展示问题和选项
3. Agent 在 Shell 中 curl 轮询 Hub 等待回复
4. 回复到达后 Agent 在当前 step 继续工作

## 实验设计（方案 D）

见 `EXPERIMENT-askquestion-cost.md`
