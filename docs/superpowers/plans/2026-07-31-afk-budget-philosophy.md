# AFK × PolarManager · 资源哲学与流程硬化（afk-solo）

> Mode=solo · never-ask · **禁止重启** PolarPort / PolarProcess / PolarBudget / polarcop-hub（本轮开发约束）。  
> 允许：对**可暂停**低优先级业务服务做 PolarProcess **stop（暂停）** / **start（恢复）**——这是预算哲学，不是开发期乱重启权威服务。

## 问题

1. AFK 只在「开主会话」时读一次 Budget；spawn-queue / subagent 池预算盲。
2. PolarBudget 只会 QoS demote，不会告诉 AFK「该停谁、何时恢复」。
3. 高负载时 Agent 继续 spawn → 交互卡死；低负载时服务被 demote 却占着内存/文件。

## 原则（哲学）

```
吃满可用算力，但不长期压死交互。
Budget 只建议与计量；Process 才动手启停；AFK 编排决策。
先降并发（不 spawn / 缩池），再暂停可恢复的低优先级服务，最后才是 PAUSE 任务。
权威服务永不进暂停名单。
有余量时按相反顺序恢复。
```

压力阶梯：

| level | 含义 | AFK 动作 |
|-------|------|----------|
| `plenty` | 余量充足 | 可按 recommended_jobs 开池 / spawn |
| `tight` | 吃紧 | 禁止超额 spawn；desiredSubagents 钳到 recommended |
| `critical` | 危险 | 暂停 pausable 低优服务；拒绝新 spawn |
| `recovering` | 回升中 | 按队列恢复被暂停服务 |

## 单元

| ID | 内容 | VERIFY |
|----|------|--------|
| U1 | 冻结本文 + CRITERIA + DECISIONS | 文件存在 |
| U2 | PolarBudget：`pressure_level` + pause candidates API | `npm test` in PolarBudget |
| U3 | PolarCopilot：spawn-queue / subagent 读 Budget | `vitest tests/rr` |
| U4 | PolarCopilot：budget-shedder（pause/resume via Process） | unit tests |
| U5 | Skills：polar-budget / subagent-lifecycle / workflow | sync-skills verify |

## 非目标

- 不重启权威服务做冒烟
- Budget 不直接调用 PolarProcess（权威边界不变）
- 不杀 interactive / Hub / Budget / Port / Process
