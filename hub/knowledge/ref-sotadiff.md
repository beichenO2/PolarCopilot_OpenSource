# SoTADiff — Agent 变更追踪与验证框架

> 来源：用户手写笔记 2026-04-19
> 状态：设计草案 v1

---

## 1. 核心概念

**SoTADiff = Agent 修改记录器**

每个 Agent 的修改都需要记录：
- **diff**：具体改了什么（文件、行号、内容）
- **intent**：为什么改（意图声明）

### 解决的问题

| 问题 | 描述 | SoTADiff 如何解决 |
|------|------|------------------|
| Revert 问题 | A Agent 改动被 B Agent 覆盖 | diff 追踪 → 冲突检测 |
| 多 Agent 冲突 | 同时修改同一文件 | 意图审查 + 阻塞验证 |
| 文档不同步 | Agent 不知道其他 Agent 做了什么 | diff 日志共享 |
| 上下文遗忘 | Agent 重启后丢失上下文 | diff 持久化恢复 |

---

## 2. SoTADiff 数据格式

### 2.1 changelog.jsonl（追加式日志）

存储在 `.planning/diff/changelog.jsonl`：

```jsonl
{"id":"d001","ts":"2026-04-19T12:00:00Z","agent":"solo-web-1234","intent_id":"i001","files":[{"path":"src/server.ts","op":"modify","lines_changed":15}],"git_commit":"abc1234","summary":"修复 Hub 心跳超时逻辑"}
{"id":"d002","ts":"2026-04-19T12:05:00Z","agent":"slave-web-5678","intent_id":"i002","files":[{"path":"src/tasks/service.ts","op":"modify","lines_changed":8},{"path":"tests/tasks.test.ts","op":"create","lines_changed":45}],"git_commit":"def5678","summary":"添加任务优先级排序"}
```

### 2.2 意图声明（intent）

存储在 `.planning/diff/intents/`，每次重大修改一个文件：

```markdown
# Intent: i001

- **Agent**: solo-web-1234
- **Time**: 2026-04-19T12:00:00Z
- **Task**: 修复 Hub 心跳超时
- **Files**: src/server.ts
- **破坏性**: 否
- **覆盖前序 diff**: 否
- **用户明确要求**: 是（任务 #42）
```

---

## 3. 冲突检测

### 3.1 检测规则

```
当 Agent B 的 diff 修改了 Agent A 已修改的文件时：

1. 检查 Agent B 的 diff 是否"去除"了 Agent A 的 diff
   ├── 是 → 触发冲突警报
   │   ├── 检查 Agent B 的 intent：用户是否明确要求覆盖？
   │   │   ├── 是（有用户指令） → 允许，记录覆盖日志
   │   │   └── 否（Agent 自主决定） → 阻塞，等待 SoTAgent 审查
   └── 否 → 正常追加 diff
```

### 3.2 冲突检测实现

基于 git diff 分析：
1. Agent 完成修改后，计算 `git diff HEAD~1`
2. 与 changelog 中的前序 diff 比对受影响文件
3. 如果发现"减法 diff"（删除了前序 diff 新增的内容），触发冲突

### 3.3 意图审查（Intent Review）

检查项：
- 用户是否**明确要求**破坏之前的修改？
- 修改是**功能替换**还是**意外回退**？
- 前序 diff 的功能是否仍然需要？

---

## 4. 三层验证体系

### 4.1 Blinding 验证

| 检查项 | 说明 |
|--------|------|
| 过程验证 | Agent 执行过程是否规范 |
| 技术分类 | 修改属于什么技术领域 |
| SOTA 认证 | 是否达到当前最佳实践 |
| SOTA 链接 | 与已有 SOTA 文档的关联 |

### 4.2 Rule 验证

| 检查项 | 说明 |
|--------|------|
| 无冲突验证 | 修改不与现有规则冲突 |
| 无丢失验证 | 修改不丢失已有功能 |

### 4.3 Diff 验证

| 检查项 | 说明 |
|--------|------|
| 无回退验证 | 不意外回退前序修改 |
| 功能验证 | 虽有上一个 diff 但不破坏顶层功能 |

### 4.4 验证失败处理

```
验证失败 → 报警 → 认证不通过
  → 阻塞式验证：下游 Agent 必须等待 SoTAgent 结果再行动
```

---

## 5. Context: R-ReadDiff-Write 模式

### 传统模式的问题

**R-RW（Read-Think-Write）**：
- 适合单 Agent
- 多 Agent 场景下，Agent 之间会覆盖修改

### 改进模式

**R-ReadDiff-Write**：
1. **Read** — 读取文件当前内容
2. **ReadDiff** — 读取该文件的 SoTADiff 历史（谁改过、为什么改）
3. **Think** — 基于当前内容 + diff 历史做决策
4. **Write** — 写入修改 + 记录新的 diff

这解决了多 Agent 场景下的"上下文污染"问题。

---

## 6. Agent 工作流集成

### 每次修改的流程

```
1. Agent 声明 intent（要改什么、为什么改）
2. 读取相关文件的 diff 历史
3. 执行修改
4. 记录 diff 到 changelog.jsonl
5. git commit
6. SoTAgent 异步验证（Blinding + Rule + Diff 三层）
7. 验证通过 → 正常继续
8. 验证失败 → 阻塞 + 报警
```

### 轻量级模式（Copilot 日常使用）

对于简单修改，不需要完整的三层验证：
- **单文件修改** → 仅记录 diff，跳过 Blinding
- **用户明确指令** → 仅记录 diff + intent，跳过 Rule 验证
- **多 Agent 场景** → 完整三层验证

---

## 7. 存储位置

```
.planning/
└── diff/
    ├── changelog.jsonl    # 变更日志（append-only）
    └── intents/           # 意图声明文件
        ├── i001.md
        ├── i002.md
        └── ...
```

changelog.jsonl 建议 `.gitignore`（运行时产物），但 intents/ 应纳入版本控制（设计决策记录）。

---

## 8. 未来演进

1. **Hub 集成**：SoTADiff 事件通过 Hub pub/sub 广播给所有 Agent
2. **自动回退**：验证失败时自动 `git revert` + 通知
3. **冲突仲裁**：Hub 协调多个冲突 Agent 的优先级
4. **经验学习**：高频冲突模式自动生成新的 Rule
