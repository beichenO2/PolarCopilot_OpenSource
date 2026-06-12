# .planning 文件夹格式规范（PolarCopilot v2）

> 本文件定义 PolarCopilot 使用的 `.planning/` 目录标准结构。
> 所有 PolarCopilot Agent（Solo、Slave、Cooperate）读写 `.planning/` 时必须遵循此规范。

---

## 1. 格式版本标识

每个 `.planning/` 目录**必须**包含 `version.json`：

```json
{
  "format": "polarcop-v2",
  "migrated_from": null,
  "migrated_at": null,
  "project": "项目名",
  "created_at": "2026-04-19T12:00:00Z"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `format` | 是 | 固定值 `"polarcop-v2"` |
| `migrated_from` | 否 | 迁移来源：`"gsd-v1"` / `"polarisor-flat"` / `null`（原生创建） |
| `migrated_at` | 否 | 迁移时间戳 |
| `project` | 是 | 项目名称 |
| `created_at` | 是 | 创建时间 |

---

## 2. 目录结构

```
.planning/
├── version.json              # 格式版本标识（必须）
├── project.md                # 项目身份、核心价值、约束、关键决策
├── state.md                  # 当前状态、进度、Session Continuity
├── roadmap.md                # 里程碑、阶段、依赖、进度表
├── requirements.md           # 需求列表（带 ID 追溯）
├── config.json               # 工作流配置（模式、粒度、干预点等）
│
├── knowledge/                # 知识沉淀（研究、设计、决策记录）
│   ├── research/             # 外部研究（技术栈、架构、陷阱等）
│   ├── design/               # 设计文档
│   └── decisions/            # 架构决策记录（ADR 风格，可选）
│
├── agents/                   # 多 Agent 协调
│   ├── protocol.md           # Agent 间协议（角色、信号、所有权）
│   ├── prompts/              # Agent 执行 prompt（按角色/阶段）
│   └── state/                # Agent 运行时状态（按 agent_id）
│
├── diff/                     # SoTADiff 变更追踪
│   ├── changelog.jsonl       # 变更日志（append-only JSONL）
│   └── intents/              # 变更意图声明（每次重大修改一个文件）
│
├── reports/                  # 报告
│   ├── audits/               # 审计报告
│   ├── bugs/                 # Bug 报告
│   └── handoff/              # 交接文档
│
├── hub/                      # Hub 运行时（自动管理）
│   ├── last-port             # Hub 端口号
│   └── hub.sqlite            # Hub 持久化（.gitignore）
│
├── signals/                  # 完成信号（文件系统信号量）
│
└── logs/                     # 运行日志（.gitignore）
    ├── hub.log
    └── agents/
```

---

## 3. 核心文件规范

### 3.1 project.md

顶级 `# {项目名}`，必须包含：
- `## What This Is` — 一句话说明
- `## Core Value` — 核心价值主张
- `## Requirements` → `### Validated` / `### Active` / `### Out of Scope`
- `## Context` — 动机和技术环境
- `## Constraints` — 约束条件
- `## Key Decisions` — 决策表（Decision / Rationale / Outcome）
- `## Design Principles` — 设计原则（可选）

### 3.2 state.md

- `## Current Position` — Phase / Plan / Status / Progress bar
- `## Session Continuity` — Last session / Stopped at / Next step
- `## Accumulated Context` — Decisions / Pending Todos / Blockers

### 3.3 roadmap.md

- `## Overview` — 一段话总结
- `## Phases` — 阶段清单（`- [x]` / `- [ ]`）
- `### Phase N: {Name}` — Goal / Depends on / Requirements / Success Criteria
- `## Progress` — 进度表

### 3.4 requirements.md

- 按类别分组（`## Category`），每个需求有 ID（如 `HUB-01`、`R1.1`）
- 追溯矩阵（Requirement → Phase → Status）

### 3.5 config.json

```json
{
  "workflow": {
    "mode": "yolo",
    "granularity": "standard",
    "parallel_execution": true,
    "commit_planning_docs": true,
    "research_enabled": true,
    "plan_checker_enabled": true,
    "verifier_enabled": true
  },
  "model_profile": "inherit",
  "human_intervention": "requirements_only",
  "planning": {
    "commit_docs": true,
    "search_gitignored": false,
    "sub_repos": []
  },
  "git": {
    "branching_strategy": "none",
    "base_branch": null,
    "phase_branch_template": "gsd/phase-{phase}-{slug}",
    "milestone_branch_template": "gsd/{milestone}-{slug}"
  },
  "system": {
    "copilot_or_pilot": "copilot",
    "identity": "PolarCopilot"
  }
}
```

---

## 4. 老版本格式检测与迁移

### 4.1 检测规则

```
读取 .planning/ 时的决策树：

1. 检查 version.json 是否存在
   ├── 存在 → 检查 format 字段
   │   ├── "polarcop-v2" → ✅ 新格式，直接使用
   │   └── 其他 → ⚠️ 未知格式，尝试解析后迁移
   └── 不存在 → 进入老版本检测
       ├── 检查是否有 PROJECT.md（大写）
       │   ├── 有 → GSD v1 老格式
       │   └── 无 → 检查 project.md（小写）
       │       ├── 有 → Polarisor 扁平格式
       │       └── 无 → 空目录或非标准，创建骨架
       └── 执行迁移
```

### 4.2 GSD v1 → PolarCopilot v2 迁移映射

| GSD v1 文件 | → v2 位置 | 说明 |
|-------------|-----------|------|
| `PROJECT.md` | `project.md` | 小写重命名，内容保留 |
| `STATE.md` | `state.md` | 小写重命名 |
| `ROADMAP.md` | `roadmap.md` | 小写重命名 |
| `REQUIREMENTS.md` | `requirements.md` | 小写重命名 |
| `RESEARCH.md` | `knowledge/research/RESEARCH.md` | 移入 knowledge/ |
| `DESIGN-V2.md` | `knowledge/design/DESIGN-V2.md` | 移入 knowledge/ |
| `HANDOFF.md` | `reports/handoff/HANDOFF.md` | 移入 reports/ |
| `BUG-REPORT.md` | `reports/bugs/BUG-REPORT.md` | 移入 reports/ |
| `AUDIT-REPORT.md` | `reports/audits/AUDIT-REPORT.md` | 移入 reports/ |
| `PACKET-CONTRACT.md` | `knowledge/design/PACKET-CONTRACT.md` | 移入 knowledge/ |
| `agent-protocol.md` | `agents/protocol.md` | 移入 agents/ |
| `agent-*-prompt.md` | `agents/prompts/` | 移入 agents/prompts/ |
| `phase-*-prompt.md` | `agents/prompts/` | 移入 agents/prompts/ |
| `config.json` | `config.json` | 保留，追加 system 字段 |
| `research/` | `knowledge/research/` | 整体移入 |
| `signals/` | `signals/` | 保留 |
| `hub/` | `hub/` | 保留 |

### 4.3 Polarisor 扁平格式 → v2 迁移

Polarisor 根目录的 `.planning/` 使用大写文件名但无 agent 协议文件：
- 同样执行大写→小写重命名
- `logs/` 保留
- `hub/` 保留

### 4.4 迁移安全保证

- **原子性**：先创建新结构，再移动文件，最后写 version.json
- **可逆性**：迁移前在 `.planning/_backup_pre_v2/` 备份所有原文件
- **兼容读取**：迁移后若发现大写文件名（旧引用），自动映射到新位置

---

## 5. .gitignore 推荐

```gitignore
.planning/hub/hub.sqlite
.planning/hub/hub.sqlite-wal
.planning/hub/hub.sqlite-shm
.planning/logs/
.planning/agents/state/
.planning/diff/changelog.jsonl
.planning/_backup_pre_v2/
```
