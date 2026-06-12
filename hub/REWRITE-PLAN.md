# gsd-2 完全取代 gsd-1 — 重写计划

## 目标

用 gsd-2 的多 Agent 常驻协作架构完全取代 gsd-1（get-shit-done）的工作流系统。

核心原则：
- **禁止使用 subagent / Task 工具**：所有 Agent 都是独立的 Cursor CLI session，通过 Hub 通信
- **Agent 不可关闭**：初始化后的 Agent 一路跑到死，不使用 while 循环重启，死亡后由备用池继任
- **通信闭环**：代理↔主控↔工人↔超管 的消息循环永不中断
- **用户交互**：用户只和代理对话（就是 Cursor Chat），用 AskQuestion 做交互
- **全局初始化确认**：所有项目确认后全局锁死资源，不允许新建/关闭 Agent

---

## 需要从 gsd-1 迁移的能力

### P0：核心工作流（必须有）

| 能力 | gsd-1 实现 | gsd-2 新实现 |
|---|---|---|
| 新项目初始化 | `new-project.md` workflow | 代理引导用户 → 生成 PROJECT.md + ROADMAP.md |
| 需求管理 | `REQUIREMENTS.md` template | 代理生成 → 主控参考 |
| 阶段规划 | `plan-phase.md` + researcher + planner | 主控拆解 → 分配给研究工人 → 生成 PLAN.md |
| 阶段执行 | `execute-phase.md` + executor waves | 主控分配 → 工人执行 → 超管审查 |
| 验证 | `verify-work.md` + verifier | 超管审查 → 代理做最终验收 |
| 进度追踪 | `STATE.md` + `gsd-tools` | Hub 任务状态 + `.planning/STATE.md` |

### P1：增强功能（很想要）

| 能力 | gsd-1 实现 | gsd-2 新实现 |
|---|---|---|
| 代码库分析 | `map-codebase.md` | 工人并行扫描 → 汇总到报告 |
| UI 设计 | `ui-phase.md` + ui-researcher | 专门的 UI 工人 |
| 调试 | `debug.md` | 专门的调试工人 |
| Todo/笔记 | `check-todos.md`, `note.md` | Hub 内置 |
| 里程碑管理 | `complete-milestone.md` | 主控 + 代理 |

### P2：运维功能（可以后做）

| 能力 | gsd-1 实现 | gsd-2 新实现 |
|---|---|---|
| 安装器 | `bin/install.js` | 不需要，直接复制 |
| 多运行时支持 | Claude/Cursor/Codex/... | 只支持 Cursor CLI |
| 钩子系统 | `hooks/` | CLK + 超管替代 |
| 工作区管理 | `workstreams/` | Hub 的多任务队列 |

---

## 实施阶段

### 阶段 1：项目初始化工作流
- 代理通过对话理解用户需求
- 生成 PROJECT.md（项目概述、技术栈、约束）
- 生成 REQUIREMENTS.md（需求列表）
- 生成 ROADMAP.md（阶段分解）
- 初始化 .planning/ 目录结构

### 阶段 2：阶段规划工作流
- 主控接收阶段目标
- 分配研究工人分析实现方案
- 生成 PLAN.md（任务分解、依赖关系）
- 超管审查计划质量

### 阶段 3：阶段执行工作流
- 主控按 PLAN.md 拆解任务
- 按模块分配给工人
- 工人执行并报告结果
- 主控汇总进度、处理阻塞

### 阶段 4：验证工作流
- 超管审查代码质量
- 代理做最终验收（对照需求文档）
- 生成验证报告

### 阶段 5：持续运营
- 里程碑管理
- 代码库分析
- 调试工作流
- 报告系统
