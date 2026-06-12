# Copilot System & Pilot System 架构设计

> 来源：用户手写笔记 2026-04-19 + 架构矫正 2026-04-24
> 状态：设计草案 → 架构矫正完成

---

## 1. 双系统概述（平级关系）

Polarisor 的 AI Agent 分为两个**平级**系统（不是上下级）：

| 维度 | Copilot System | Pilot System |
|------|---------------|--------------|
| 定位 | 日常编码执行者 | 自主项目执行系统（PolarClaw 的打手系统） |
| 归属 | PolarCopilot 项目 | **PolarClaw 子项目** |
| 入口 | IDE（Cursor）+ Hub Web | PolarClaw Web / Hub Web（共用前端） |
| 复杂度 | 单任务/单阶段 | 多阶段流程、LLM 驱动分解 |
| Agent 模式 | Solo / Slave / Cooperate / YOLO | LLM Proxy 驱动 + 记忆本地管理 + 架构完全自主 |
| 技术栈 | PolarCopilot Hub (Express + MCP + Drizzle) | PolarClaw (Express + better-sqlite3 + ILLMRouter) |
| 设计哲学 | "帮你写代码" | "IO is All — 定义输入输出，LLM 自主实现" |

### 关键矫正

```
Pilot ≠ Copilot 的下级系统
Pilot = PolarClaw 的子项目，与 Copilot 平级
前端共用：Hub Web 的 PilotPage 代理 PolarClaw /api/pilot/* API
```

### 渐进路线

```
新成员 → Copilot（日常编码）→ Pilot（项目管理）
        PolarCopilot              PolarClaw
```

新用户先通过 Copilot 学习生态规则，熟悉后使用 Pilot 进行更复杂的项目管理。

---

## 2. Copilot System（当前 — PolarCopilot）

### 能力范围

- **IDE 模式**：Cursor Agent 通过 Skills 执行任务
- **Web 模式**：Hub Web UI 发送命令，Agent 轮询执行
- **Solo & Slave**：单 Agent 或主从协作
- **Cooperate**：Orchestrator + Domain Workers 多 Agent 协作

### 已知痛点（来自手写笔记）

1. **任务只是一个"点"** — 实际代码改动可能是大面积的
2. **需要预判影响** — 改一处可能影响多处（用 graphity 可视化依赖）
3. **Agent "完美实现"的挑战**：
   - 不光功能 OK
   - 还要遵循所有规则
   - 处理冲突
   - 改动所有相关位置
   - 避免"来世 bug"（当前看不到但未来会爆的问题）

### Copilot 的改进方向

1. **规则全面化** — 一般规则针对 Copilot 设计（不是 Agent 级别）
2. **SoTADiff** — Agent 修改追踪器（见下文）
3. **Ground-Truth 事实检查** — GT-Slave 验证 Agent 输出
4. **关键部件人工完成** — 一切规则改动由 SoTAgent 负责

---

## 3. Pilot System（PolarClaw 子项目 — 基础可用）

### 设计理念："IO is All"

- 用户**只关心输入格式**
- 具体实现方式由 LLM 自主决定（高度自治）
- 关注输出的依赖关系和生成逻辑

### 归属与架构

Pilot 是 **PolarClaw 的子项目**，不在 PolarCopilot 内部：

| 组件 | 位置 | 说明 |
|------|------|------|
| PilotStore | `PolarClaw/src/adapters/pilot/store.ts` | SQLite 持久化 (pilot.db) |
| PilotEngine | `PolarClaw/src/adapters/pilot/engine.ts` | LLM 分解 via ILLMRouter |
| REST API | `PolarClaw/src/adapters/web/server.ts` | /api/pilot/* |
| Hub PilotPage | `PolarCopilot/web/src/pages/PilotPage.tsx` | **代理** PolarClaw API |
| Hub 代理 | `PolarCopilot/hub/src/transport/http.ts` | port-sdk 发现 PolarClaw → 透传 |

### 与 Copilot 的区别

| 特性 | Copilot | Pilot |
|------|---------|-------|
| 归属 | PolarCopilot | PolarClaw |
| LLM 调用 | Hub MCP 转发 | PolarClaw ILLMRouter 直接调用 |
| 记忆管理 | Hub 临时上下文 | PolarClaw SQLite 本地持久化 |
| 代码审查 | 手动/Agent review | 自动化代码审查 (规划中) |
| 流程复杂度 | 简单线性 | 多阶段 LLM 驱动分解 |

### 输入 → 输出模型

```
新成员接入：
  Input: 需求手册 → 发起确认
    → 确认 output 的依赖关系、关系及生成逻辑
    → 示范 UZ + MVP（可以抛砖引具体逻辑、展示 IO）
    → 可用项目
```

---

## 4. 技术路线

### LLM 引擎

PolarPrivate 提供的 LLM Proxy — 统一管理所有 LLM 调用。

### 开发路线

- **Claude Code** — 改写做打手（辅助重构、批量修改）
- **Hermes** — 开发主工作（Hub Web 前端等）
  - Hub Web 前端 → 新页面，ChatGPT 风格 UI
  - 注意：此处 Hermes 指 Hub Web UI 开发工作（ChatGPT 风格对话界面），
    与 LetMeSeeSee/Hermes/RESEARCH.md 中的 "Hermes Agent"（Nous Research 自学习 Agent 框架）
    是两个不同概念。后者是 PolarClaw/OpenClaw 忒修斯之船融合方案的参考项目。

### 子项目状态

| 项目 | 关注点 |
|------|--------|
| AutoOffice | PPT, PDF, LaTeX→PDF 三种格式输出效果 |
| Digist | 合作记录、表现评估 |

---

## 5. SoTAgent 的角色

> SoTAgent = 3 Agent 组，Polarisor 的稳定路由中心

### 三大组件

| 组件 | 职责 | 内容 |
|------|------|------|
| **Blinding** | 结晶化、技术 SOTA 认证 | 技术分类 + SOTA 认证 + SOTA 关联 |
| **Rule** | 规则保护网 | 冲突检测、无损验证 |
| **Diff** | 修改记录器 | 驱动 SOTA（防意外回退） |

### 验证体系

| 验证类型 | 验证内容 |
|---------|---------|
| Blinding 验证 | 过程、技术分类、SOTA 认证 + SOTA 链接 |
| Rule 验证 | 无冲突验证、无丢失验证 |
| Diff 验证 | 无回退验证（虽有上一个 diff 但不破坏顶，有功能验证！） |

认证失败 → 报警 → 认证不通过 → **阻塞式验证**（下游 Agent 需要等 SoTAgent 结果再行动）

### SoTAgent 内部结构

```
SoTAgent:
├── ClawMem+                    # 经验记忆
├── 结晶化: SOTA Blinding      # 异步更新 blinding 文档
├── 规则: SOTArule              # 规则管理
├── 接驳 gsd2 & 资取 link       # 与 PolarCopilot 集成
├── 独立 cache:
│   ├── GSD2-cache              # PolarCopilot 缓存
│   ├── skills cache            # Cursor Skills 缓存
│   └── 中继文件                 # Hub 通信中继
└── 工作模式:
    ├── gsd2 Web - solo         # 专门去实体改进
    └── 科研也给他！同源         # 科研任务也接入
```

---

## 6. 异常处理

### SoTADiff 异常检测

```
Agent 修改记录器: diff + 意图

冲突检测: diff 去除之前的 diff
意图审查: 用户是否明确要求破坏之前的 diff?
```

### 传统程序 + Agent 的解决方案

Agent 只提供独立智能，传统程序负责：
- 上下文无污染
- 并行提 Agent 精髓

### Copilot 事实检查

```
Ground-Truth = GT-Slave
  从工程角度、验收角度、进度
  Key: 绝大部分错误的根本原因 → 执行时作弊
  以级 solve，在如搞则的时候 solve
```

关键部件以级达人完成 → 一切规则改动由 SoTAgent 负责。

---

## 7. 路径问题

> Agent 不应是按我的计划行事，也有自己的考量、可实现性、
> 时不时理解不同。
> 准作一个 ROADMAP，写实际代码中用到的实现的逻辑。
> （心智审查+需和可好，但更长时间尺度）
> 我的原话，不准轻视。
