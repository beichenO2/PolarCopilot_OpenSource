# PolarSoul — PolarCopilot 设计灵魂

## 设计哲学

PolarCopilot 是 Polarisor 的 IDE Agent 框架，通过 Hub Web 与用户交互，提供 Agent 注册、事件路由、SSoT 管理、YOLO 对齐审核、Prolusion 规划等核心基础设施。

- **集中式事件代理**: Agent 之间不直接通信，Hub 通过 topic 路由一切
- **SSoT 为唯一事实源**: polaris.json 是项目事实的唯一来源
- **结构化规划优于临时任务**: Prolusion 四阶段流程防止遗漏依赖
- **安全阻塞**: Agent 等待人类输入时暂停，防止竞态条件
- **进化为一等公民**: Agent 行为变更被追踪、建议、需审批

## 功能介绍

**生态位**: IDE Agent 框架，通过 Hub Web 和 VSCode 插件两种方式与用户交互

**承担功能**:

- **R1**: Hub Web UI — React 18 SPA（Prompts 页、SSoT 页、EcoTree、SSE 流式、Agent 阻塞、Agent 卡片、Dashboard 服务监控、History 折叠、Annotation 消费循环、YOLO 页、YOLO+SSoT 双栏、Pilot 状态页、Checkup Widget）
- **R2**: 多 Agent 协调 — Agent 注册/心跳、Slave 发现/调度、事件系统（pub/sub）、YOLO 对齐、生命周期管理、文件租约执行、项目所有权持久化、协议脚本外部化、Skill 分层加载、checkup-event 路由
- **R3**: SSoT 文档管理 — polaris.json 规范、Hub 聚合 API、Annotation 系统、全项目部署、Annotation topic 聚合、SSoT 审计脚本
- **R4**: Skills/Rules 系统 — pc-principles、pc-solo-web、pc-web-yolo、pc-slave-web、pc-solo-qa、pc-yolo-confirm、pc-yolo-execute、pc-prolusion、pc-project-scan、P23 交叉验证、P13 语义删除、治理统一
- **R5**: 进化子系统 — 6 阶段进化管理（E1-E6）、进化页面
- **R6**: Prolusion 规划系统 — 4 阶段结构化规划、Prolusion 前端、Agent 任务派发、Smart Prompt 生成
- **R7**: 文档重构 — SSoT 收敛、roadmap.md、reference/、knowledge/、blacklist 清理
- **R8**: IDE 插件（polarcop-vscode/） — VSCode/Cursor 侧边栏对话面板，通过 HTTP/SSE 调用 PolarClaw API，提供独立于 Cursor AI 对话的 IDE 入口（类似 Cloud Code）

## 与其他项目的关系

- 依赖 SOTAgent（端口分配）、PolarClaw（LLM 代理）
- 被所有 Agent 依赖（注册、事件、SSoT、YOLO、Prolusion、Evolution）
- Skills 系统（pc-*）定义 Agent 行为协议

## 关键设计决策

- **Why Hub as event proxy**: Agent 间解耦，Hub 统一路由和审计
- **Why Prolusion replaces scattered Tasks**: 结构化规划防止遗漏依赖和范围蔓延
- **Why Agent blocking mechanism**: 等待人类输入时暂停，防止竞态和错误决策
- **Why IDE 插件归 PolarCopilot 而非 PolarClaw**: PolarCopilot 定位是 IDE Agent 框架，IDE 前端（无论是 Hub Web 还是 VSCode 插件）都是它的组成部分。PolarClaw 负责 Agent 后端能力，不应同时承担前端。这样两者可独立演进——插件 UI 变更不影响 Agent 逻辑，Agent 升级不影响 IDE 体验。

## 依赖与被依赖

- **依赖**: PolarPort/sdk, PolarClaw (LLM proxy)
- **被依赖**: 所有 Polarisor Agents
