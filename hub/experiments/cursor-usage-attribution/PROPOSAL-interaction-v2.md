# 交互协议 v2：减少 AskQuestion 请求开销

## 当前问题

v1 协议强制"每轮末尾必须 AskQuestion"，导致：
- 任务完成后 AskQuestion → 用户选"继续" → 恢复请求 (3-5万 tokens) → 做事
- 用户其实只想让你做完就行，不需要每次都问

每次 AskQuestion 交互 = 1 个额外的小 API 请求（用户回复后 Cursor 需要新请求恢复 Agent）

## 提案：分级 AskQuestion 策略

### 级别 1：必须 AskQuestion（不变）

- 多种方案有实质性取舍，无法判断用户偏好
- 破坏性操作（改架构、删大量代码、改 API 接口）
- 需求模糊到无法开始工作
- 遇到阻塞性错误，自己无法解决

### 级别 2：不再 AskQuestion（新增）

- ~~任务完成后问"接下来？"~~ → **直接输出报告停止**。用户有话说自然会发消息
- ~~完成一个子任务后问"继续吗？"~~ → **直接做下一个**（v1 已有但常被违反）
- ~~列完计划后问"可以吗？"~~ → **直接执行**
- ~~修完 bug 后问"还有什么？"~~ → **看待办列表，有就做，没有就停**

### 关键变更

```diff
- Agent 的每一轮回复末尾必须包含一个 AskQuestion 调用来延续对话
+ Agent 完成所有已知任务后直接输出报告并停止。
+ 只在需要用户做决策（级别 1 场景）时才用 AskQuestion。
```

### 预期收益

- 每 session 减少 1-3 个 AskQuestion 交互
- 减少 1-3 个恢复请求（每个 3-5 万 tokens）
- 总节省约 3-15 万 tokens/session

### 风险

- 用户可能觉得 Agent "不够有礼貌" — 但可以在报告末尾加一句"如需继续请发消息"
- 致继任者同步可能被跳过 — 把同步义务放在"完成报告"步骤内，而不是 AskQuestion 后

## 与 available_skills 列表的关系

另一个大问题：Cursor 把 **所有 80+ 个注册 skill 的描述** 都放进每个请求的 system prompt。
每个 skill entry ≈ 50-80 tokens，80 个 ≈ 4000-6000 tokens。
这是**不可控的固定开销**，除非减少注册的 skill 数量。

### 建议
- 把不在当前项目使用的 gsd-1 skills 从 `~/.cursor/skills/` 移走
- 只保留 gsd2-* 系列 + autooffice-* 系列
- 或者 Cursor 未来提供按项目配置 skill visibility 的功能
