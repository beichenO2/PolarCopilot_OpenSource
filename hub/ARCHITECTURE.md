# gsd-2 多 Agent 常驻协作系统 — 架构设计

## 1. 系统概述

一个由 100+ 个 Cursor CLI Agent 组成的常驻工作系统。启动一次后持续运行，不停机。由一个中央 MCP Hub 提供通信和状态管理，由时钟信号驱动整个系统持续运转。

核心原则：
- **一次点火，持续运行**：所有 Agent 在启动阶段一次性创建，之后不再新建
- **Agent 尽量长活**：Agent 应尽量在内部循环中持续运行（不断调用 Shell 工具），直到 context window 耗尽。Launcher 使用 while true + 指数退避重启，在 Agent 因任何原因退出后恢复工作。快速退出（<2min）触发退避增长，正常退出（>2min）重置退避
- **Agent 是职员不是螺丝**：每个 Agent 长期复用，积累上下文和模块经验
- **消息驱动 + 时钟兜底**：正常情况下消息驱动工作流转，CLK 时钟防止死锁
- **故障自愈**：任何角色死亡后，从备用池中继任（不算新建 Agent）+ launcher 自动重启
- **禁止使用 subagent**：所有 Agent 都是独立 Cursor CLI session，通过 Hub 通信
- **全局初始化确认**：所有项目初始化完成后全局锁死资源，不允许新建/关闭 Agent
- **防止重复创建**：启动前检查 tmux session 和启动标记文件，避免重复创建 Agent

---

## 2. 角色定义

### 2.1 代理（Proxy）

**唯一与用户对话的角色。唯一通过 IDE 启动的角色（用户能看到对话窗口）。**

职责：
- 和用户沟通需求
- 理解用户方案或协助用户形成方案
- 启动项目：创建所有 Agent、分配管理角色
- 判断启动是否完成（必须等用户确认）
- 用户在线时：转发需要用户决策的问题
- 用户睡觉时：拿着需求文档代替用户做验收，逐条核对需求是否满足
- **跨项目依赖管理**：声明本项目依赖的外部能力、发布本项目已完成的能力

不做的事：
- 不直接写代码（守望模式下不做任何消耗 context 的工作）
- 不指挥工人干活
- 不参与技术决策

通信对象：用户（直接对话）、主控（下达工作指令、转发用户反馈）、其他项目代理（通过协调文件夹）

#### 守望模式（Watchman Mode）

**问题背景**：代理是唯一通过 IDE 启动的角色，只有代理能跟用户真正交互。其他所有 Agent 都通过 CLI 启动，用户看不到。一旦代理 context window 耗尽先于其他 Agent 死亡，用户就失去了唯一的交互窗口——即使其他 Agent 还活着也无法与用户沟通。

**解决方案**：代理在完成启动阶段（创建所有子 Agent、下发第一个 phase_objective）后，立即进入**守望模式**，将日常指挥权委托给主控。

守望模式下代理只做以下极低消耗的操作：
- 轮询 `proxy.inbox` 信道（读取主控/超管的汇报）
- 发送心跳（`hub_heartbeat_role`）
- 扫描协调文件夹（跨项目依赖检查、bug 通知、能力就绪通知）
- 响应用户消息（如果用户在 IDE 中说话，转发给主控）
- 检查是否只剩自己（所有 CLI Agent 是否全部死亡）

守望模式下**不做**的事：
- 不写代码、不分析代码、不拆解任务
- 不主动阅读大量文件
- 不做任何消耗大量 token 的操作

**最后一棒模式（Last Stand Mode）**：当所有 CLI Agent 都死了（主控、超管、CLK、工人、备用池全部耗尽），代理切换为"最后一棒模式"——自己同时扮演主控+工人：
1. 自己 `hub_claim_task` 领取任务
2. 自己执行任务（写代码、跑测试）
3. 自己 `hub_complete_task` 报告完成
4. 重复直到自己的 context window 也耗尽
5. 耗尽前写 HANDOFF.md 通知用户

这确保了代理**总是最后一个死的**，用户始终有一个可交互的窗口。

### 2.2 主控（Controller）

**工作指挥中心。**

职责：
- 接收代理下达的总体工作目标
- 将目标拆解为具体任务
- 将任务分配给工人（通过 Hub 任务队列）
- 发完任务后进入 check 循环（轮询信道、等待工人结果）
- 收集工人的完成报告，推进整体进度
- 收到超管的纠正建议后调整策略
- 需要新工人时，从备用池中分配角色
- **监控 CLK 是否需要替换**（发完任务后检查 CLK 心跳状态）

不做的事：
- 不和用户直接对话
- 不直接写代码
- **不监督工人的输出质量**（那是超管的职责）

通信对象：代理（接收指令）、超管（接收反馈）、工人（分配任务、收集结果）、CLK（监控其健康状态）

### 2.3 超管（Supervisor）

**质量监督者。**

职责：
- 定期审查工人的代码产出和回复内容
- 检测工人输出质量劣化（俄语/韩语等异常语言、幻觉、质量骤降）→ 上报 CLK 换人
- 评判主控的指挥质量（任务拆解是否合理、进度推进是否正常）
- 发现问题后总结，等主控空闲时反馈给主控
- 输出审查报告到报告文件夹

不做的事：
- 不直接修改代码
- 不直接给工人下命令
- 不和用户对话
- 不直接执行换人操作（上报 CLK 执行）

通信对象：主控（反馈审查结果）、工人产出（只读审查）、CLK（上报工人质量劣化）

### 2.4 时钟（CLK）

**系统心跳驱动器 + 流程健康监控。**

职责：
- 每 30 秒发一次 tick 信号到 `system.tick` topic
- **监控主控和超管的 workflow 是否健康运行**（卡死、阻塞、多 Agent 等一个 Agent 等流程问题）
- 检测主控/超管死亡 → 直接从备用池指定继任者并执行换人
- 收到超管上报的工人质量劣化 → 执行工人换人
- 如果所有管理角色都停滞超过阈值 → 向主控发唤醒信号
- 持续生成系统状态综合报告，写入 `.planning/reports/`
- **当自己是最后一个非代理可用 Agent 时：转为普通工人，自己当自己的主控继续干活**

关键特性：
- CLK 是唯一**永远主动**的角色，其他角色都可以被动等待
- CLK 自身由**主控**监控（主控发完任务后检查 CLK 心跳状态，决定要不要换）
- CLK 消耗的 token 很少（每次 tick 只是发信号 + 读状态）
- CLK 不评判输出质量，只管流程是否卡住

通信对象：所有角色（广播 tick）、主控（唤醒信号）、备用池（继任指令）、超管（接收工人劣化上报）

### 2.5 工人（Worker）

**实际执行者。**

职责：
- 接收主控分配的具体任务
- 执行任务（写代码、跑测试、搜索代码库等）
- 完成后向主控报告结果
- 长期驻守在自己负责的模块上，积累上下文

每个工人是一个模块专家。通过 Hub 的模块亲和性机制，同一模块的任务会持续分配给同一个工人。

通信对象：主控（接收任务、报告结果）

### 2.6 全局时钟（Global CLK）

**跨项目统筹者。** 全局唯一，由接最后一棒的助理在创建所有子 Agent 时一并创建。

职责：
- 每 5 分钟醒来一次，扫描所有项目的状态
- 扫描 `~/.gsd2/coordination/dependencies/` — 汇总谁在等谁
- 扫描 `~/.gsd2/coordination/capabilities/` — 检测新发布的能力
- 当发现能力就绪且有项目在等 → 通过 `messages/` 通知等待方的代理
- 扫描各项目代理的心跳 → 如果某项目代理长时间无心跳 → 记录异常
- 生成跨项目状态综合报告，写入 `~/.gsd2/coordination/global-status.json`
- **通知被依赖方**：扫描 `dependencies/`，如果发现项目A在等项目B的某个能力，向项目B的代理发送提醒（通过 `messages/`），让项目B的代理可以调整任务优先级

通信方式：全局 CLK 不通过 Hub（因为 Hub 是项目级别的），而是通过协调文件夹的文件系统进行异步通信。

不做的事：
- 不参与任何项目内部的工作
- 不直接给任何工人下命令
- 不评判任何项目的代码质量

### 2.7 备用池（Reserve Pool）

**待命替补。**

启动时创建的 Agent 中，除了分配了角色的之外，其余全部作为备用池。每个备用 Agent 处于轮询等待状态，只监听 `reserve.assign` topic。

当备用 Agent 收到分配指令时，指令中包含：
- 新角色名称
- 角色的职责 prompt
- 前任的状态快照（如果是继任）
- 负责的模块（如果是工人）

---

## 3. 通信模型

### 3.1 消息总线

所有通信通过 MCP Hub 的 broadcast 系统进行。每个角色订阅自己的 topic：

| 角色 | 订阅 topic | 发布 topic |
|---|---|---|
| 代理 | `proxy.inbox` | `ctrl.inbox`, `system.status` |
| 主控 | `ctrl.inbox`, `system.tick` | `worker.<id>.inbox`, `proxy.inbox`, `system.status` |
| 超管 | `super.inbox`, `system.tick` | `ctrl.inbox`, `system.status` |
| CLK | `clk.inbox` | `system.tick`, `ctrl.inbox`, `reserve.assign`, `system.status` |
| 工人 | `worker.<id>.inbox`, `system.tick` | `ctrl.inbox` |
| 备用 | `reserve.assign` | —（等待分配后才有发布权） |

### 3.2 消息格式

每条消息是一个 JSON 对象，包含：

```json
{
  "from": "controller",
  "to": "worker-3",
  "type": "task_assign",
  "payload": { ... },
  "timestamp": "2026-04-07T...",
  "tick_number": 42
}
```

### 3.3 消息排队规则

- 工人给主控的消息可以叠加：主控一次 poll 可以读到多条工人消息，批量处理
- 超管给主控的消息必须等主控空闲：超管发到 `controller.inbox`，主控在下一次 poll 时读到
- 实际上消息队列天然解决了这个问题——所有消息都进队列，主控按顺序读取，不存在"占用"冲突

### 3.4 工作循环

每个角色的主循环都是同一个模式——**永不退出的无限轮询**：

```
注册（仅一次）
loop forever（直到 context window 耗尽自然死亡）:
  1. poll Hub 读取自己 topic 的新消息
  2. 如果有业务消息 → 处理 → 产出结果 → 发布到对方 topic
  3. 如果收到 tick 信号 → 检查自己有没有待做的事 → 有就做
  4. 向 Hub 报告自己的活动状态（heartbeat）
  5. 短暂等待 → 回到 1
  ⚠️ 绝不主动退出。没有任务时继续轮询等待。
```

Agent 退出后的处理（两层保障）：
1. **Launcher 自动重启**：while true + 指数退避。正常退出(>2min)重置等待为5s，快速退出(<2min)翻倍等待（最大5min）。重启时附加恢复上下文（跳过初始化步骤）
2. **备用池继任**：CLK 检测 heartbeat 超时的 Agent，从备用池指定继任者

---

## 4. 启动流程

### 4.1 两种启动模式

**模式 A：用户有方案**
```
用户 → 代理："这是我的方案文档，按这个来"
代理：读取方案，理解项目结构
代理：启动 N 个 tmux CLI session
代理：分配 4 个管理角色（主控、超管、CLK、第一个代理自己就是）
代理：分配若干工人角色
代理 → 用户："启动完成了吗？"
用户："完成了"
代理 → 主控："开始工作，方案在这里"
CLK 开始 tick
```

**模式 B：用户只有需求**
```
用户 → 代理："我要做一个 XXX"
代理：和用户讨论，理解需求
代理：生成方案文档
代理 → 用户："方案是这样的，你确认一下"
用户："确认了"
代理：（同模式 A 的后续步骤）
```

### 4.2 启动阶段的 Agent 创建

代理在启动阶段执行以下步骤：

1. 创建 100 个 tmux session，每个运行 `cursor agent --print --yolo`
2. 等待所有 session 启动完毕（CLI 进入就绪状态）
   **重要**：必须使用 `--yolo` flag（不是 `--trust`），否则 Agent 的 Shell 工具会被 Rejected
3. 向前 4 个 Agent 发送角色分配 prompt（主控、超管、CLK）
4. 向若干 Agent 发送工人角色 prompt（带模块分配）
5. 其余 Agent 保持待命状态

代理自身就是第一个管理角色，不需要额外创建。

### 4.3 资源规划与全局初始化确认

**资源规划流程（由"接最后一棒的助理 Agent"决定）：**

每个项目初始化完成后，代理用 AskQuestion 问用户：

```
标题: 子 Agent 配置确认
问题: 是否现在确认子 Agent 配置？
选项:
  - 确认，开始资源规划 → 进入资源规划阶段
  - 暂不确认，我还要配其他项目 → 将需求写入 ~/.gsd2/coordination/pending-configs/<project-hash>.json
```

如果用户选"暂不确认"：
- 将本项目的需求（工人数量、模块分配、预估工作量）写入 `~/.gsd2/coordination/pending-configs/<hash>.json`
- 这个位置**所有项目的 Agent 都能看到**，实现跨项目需求汇总
- 进入待命状态（轮询 Hub 但不领取/创建任务）

如果用户选"确认"（表示这是最后一个项目）：
1. 该 Agent 成为"接最后一棒"的助理，负责**全局资源规划**
2. 读取 `~/.gsd2/coordination/pending-configs/` 下所有项目的需求
3. 检测当前系统资源（CPU、内存），计算可用容量
4. **总占用量不能超过 90%（CPU 和内存）**
5. 根据各项目需求和系统容量，生成资源分配方案：
   - 每个项目分多少工人
   - 全局备用池留多少
   - 预估可持续运行时间
6. 用 AskQuestion 展示方案给用户确认
7. 用户确认后 → 执行批量启动 → 全局锁定

**全局锁定流程（跨项目资源锁定）：**

1. 项目初始化完成后，代理向 `~/.gsd2/global-lock.json` 注册本项目
2. 所有项目确认后 → 全局锁定（locked: true）
3. 锁定后的约束：
   - 禁止创建新的 tmux session / Agent
   - 禁止关闭已有的 tmux session / Agent
   - 备用池继任仍然允许（自愈不算新建）
   - `launch-cluster.sh` 拒绝执行
   - `stop-cluster.sh` 拒绝执行（除非 `--force` 紧急覆盖）

---

## 5. 故障处理、继任与自愈

### 5.1 死亡检测

一个 Agent 被判定为死亡的条件：
- 连续 5 次 tick 没有向 Hub 报告 heartbeat（约 2.5 分钟无响应）
- 或 tmux session 进程已退出

### 5.2 质量劣化检测

**超管是唯一的质量监督者。**超管检测工人的以下异常信号：
- 莫名其妙输出俄语、韩语等非项目语言
- 输出结果明显变差（重复无意义内容、幻觉严重、逻辑混乱）
- 无法正确响应 Hub 指令（格式错误、答非所问）
- 代码质量突然骤降

检测到异常后的处理流程：
1. 超管通过 `hub_report_degradation` 上报 CLK
2. 上报内容包含 `{ type: "quality_degradation", suspect_agent_id, evidence, reporter_agent_id, severity }`
3. CLK 收到上报后执行换人：
   - 标记问题 Agent 为 dead
   - 从**全局备用池**取一个新 Agent 继任
   - 将前任的 checkpoint 和工作状态传给继任者

**判定质量劣化的是超管，执行换人的是 CLK。主控和工人都不参与质量判断。**

### 5.3 继任流程

**工人质量劣化继任：**
```
超管审查代码，发现工人-05 输出俄语
→ 超管通过 hub_report_degradation 上报 CLK
→ CLK 收到报告，标记工人-05 为 dead
→ CLK 从全局备用池取一个 Agent
→ CLK 向该 Agent 发送继任指令：
  {
    type: "role_assign",
    role: "worker",
    state_snapshot: { ... 工人-05 的最后 checkpoint ... },
    instruction: "你是新的工人，接替工人-05 的工作"
  }
→ 新 Agent 加载状态，接管工作
→ 全局备用池减少一个
```

**CLK 死亡继任：**
```
主控发完任务后检查 CLK 心跳
→ 发现 CLK 超过 3 分钟无 tick
→ 主控通过 hub_succeed_role 从备用池指定新 CLK
→ 新 CLK 开始 tick 循环
```

### 5.4 各角色的守护关系

| 如果谁死了/劣化 | 谁负责检测 | 谁执行换人 |
|---|---|---|
| 工人（质量劣化） | 超管检测 | CLK 执行换人 |
| 工人（心跳死亡） | CLK 检测 | CLK 执行换人 |
| 主控 | CLK 检测 | CLK 从备用池继任 |
| 超管 | CLK 检测 | CLK 从备用池继任 |
| CLK | 主控检测 | 主控从备用池继任 |
| 代理 | CLK 检测 | CLK 从备用池继任 |

监控关系汇总：
- 主控 → 监控 CLK（发完任务后检查 CLK 心跳状态）
- CLK → 监控 主控 + 超管（流程健康度，不是质量）
- 超管 → 监控 工人（输出质量）
- 工人 → 不监控任何人

### 5.5 全局备用池与收窄机制

**核心原则：Agent 资源只申请一次，之后不再新申请，也不使用 subAgent。**

备用池是**全局共享**的，不按项目分配：
- 启动时创建固定数量的 Agent（如 100 个）
- 分配完管理角色和初始工人后，剩余全部进入全局备用池
- 多个项目共享同一个备用池（通过 `~/.gsd2/global-reserve.json` 协调）
- 哪个项目有需求就从全局池中划出

**收窄规则：**
- 可用 Agent 越来越少 → 工作范围自然收窄
- 例：10 个 Agent 干活 → 5 个坏了全换新的 → 又坏 5 个 → 只剩 5 个好的把坏的活干完
- **CLK 是最后一个非代理 Agent 时**：CLK 停止日常工作，进入**收尾模式**——生成项目总结报告（各阶段状态、Agent 生命周期、故障记录、健康度评价），写入 `.planning/reports/clk/FINAL-SUMMARY.md`，然后通知代理并自然死亡。CLK 不转为工人——它的全局监控视角用来做总结比写代码更有价值
- **临界停止条件**：当所有非代理 Agent 都死了（包括最后的 CLK 也耗尽了）：
  1. **代理(Proxy)** 在守望循环中检测到集群资源耗尽
  2. 代理退出守望模式，进入**最后一棒模式**：自己当主控+工人继续干活
  3. 代理的 context window 也快耗尽时，将所有改动、当前进度、下一步安排写入 `.planning/HANDOFF.md`
  4. 代理通知用户（AskQuestion）
  5. 用户确认后结束任务
  6. **这是唯一的停止工作方式，只有代理有权执行**
  7. **代理始终是最后一个死的** — 守望模式确保代理消耗最少的 context

### 5.6 Context Window 耗尽（自然死亡）

Cursor CLI Agent 的 context window 有上限（约 128k tokens）。当一个 Agent 的 context 快满时：

1. Agent 检测到自己的 context 使用率超过 80%
2. 将当前工作状态写入 checkpoint（通过 Hub 的 checkpoint 机制）
3. 向 CLK 报告"我快满了"
4. CLK 从全局备用池指定继任者，传入 checkpoint
5. 旧 Agent 自然死亡（**不会被重启**，而是由继任者接替）

### 5.7 跨项目运行时协调

**公共协调文件夹**（默认 `~/.gsd2/coordination/`，可在启动时由用户指定其他路径）：

```
~/.gsd2/
  coordination/           ← 跨项目公共协调区
    pending-configs/      ← 各项目的子Agent需求（启动阶段）
    dependencies/         ← 各项目的跨项目依赖声明（见 §5.8）
    capabilities/         ← 各项目发布的已完成能力（见 §5.8）
    issues/               ← 运行时发现的 gsd-2 自身 bug
    patches/              ← 已修复的补丁记录
    reserve-pool.json     ← 全局备用池状态
    messages/             ← 跨项目代理间通信（唤醒、资源分配通知等）
  global-lock.json        ← 全局资源锁定状态
```

**运行时 bug 协调流程：**

gsd-2 本身不完美，运行中可能遇到自身的 bug。处理方式：
1. 发现问题的 Agent 将 bug 详情写入 `~/.gsd2/coordination/issues/<timestamp>-<hash>.json`
2. 各项目的代理(Proxy)定期扫描 issues 目录
3. 有能力修复的代理（通常是最空闲的那个项目的代理）负责修复：
   - 修改 gsd-2 项目代码
   - 推送到 GitHub（`git push`）
   - 在 `~/.gsd2/coordination/patches/` 写入补丁通知
4. 其他项目的代理看到补丁通知后，执行 `git pull` 拉取更新
5. **关键约束**：拉取更新后**不重启任何 Agent**
   - 如果更新需要重启才能生效 → 不更新，等下一轮（所有 Agent 自然死亡后重新启动时再生效）
   - 运行中的 Agent 继续用旧代码跑完，新接力的 Agent 自然会用新代码
   - 绝不关闭、绝不重启任何正在运行的 Agent

**跨项目代理通信：**

各项目的代理(Proxy)通过 `~/.gsd2/coordination/messages/` 互相通信：
- 最后一个接棒的代理启动所有子 Agent 后，在 messages 中给每个项目发通知：
  `{ type: "agents_ready", project_hash: "xxxx", assigned_agents: [...], reserve_pool: N }`
- 项目代理收到通知后开始工作

### 5.8 跨项目依赖协调协议

**场景**：用户同时运行多个项目（如"龙虾"项目和"爬虫工具"项目），项目间存在依赖关系。龙虾项目需要爬虫项目的搜索 API，但爬虫还没做完。龙虾项目不能空等，应先做不依赖爬虫的部分。

**核心思路**：在协调文件夹下新增"依赖声明 + 能力发布"协议，各项目代理通过文件系统异步协调。

#### 5.8.1 目录结构

```
~/.gsd2/coordination/
  dependencies/              ← 各项目声明自己依赖什么（新增）
    <project-hash>.json
  capabilities/              ← 各项目发布已完成的能力（新增）
    <project-hash>/
      <capability-name>.json
  pending-configs/           ← 已有：各项目的子 Agent 需求
  issues/                    ← 已有：运行时 gsd-2 bug
  patches/                   ← 已有：已修复补丁
  messages/                  ← 已有：跨项目通信
  reserve-pool.json          ← 已有：全局备用池
```

#### 5.8.2 依赖声明格式

每个项目在需求对齐阶段分析是否依赖其他项目。如有依赖，写入 `dependencies/<project-hash>.json`：

```json
{
  "project": "龙虾",
  "hash": "a1b2",
  "declared_at": "2026-04-09T...",
  "needs": [
    {
      "capability": "crawler.search_api",
      "from_project": "爬虫工具",
      "priority": "high",
      "description": "需要网页搜索接口来获取龙虾市场数据",
      "blocking_tasks": ["REQ-005", "REQ-008"],
      "non_blocking_tasks": ["REQ-001", "REQ-002", "REQ-003"]
    }
  ]
}
```

#### 5.8.3 能力发布格式

当某项目完成了一个可供他人使用的能力，在 `capabilities/<project-hash>/` 下发布：

```json
{
  "capability": "crawler.search_api",
  "version": "v1",
  "project": "爬虫工具",
  "hash": "c3d4",
  "ready_at": "2026-04-09T...",
  "description": "网页搜索 API 已就绪，支持关键词搜索 + 结果解析",
  "usage": "import { search } from './crawler/search-api'",
  "location": "/path/to/crawler/src/search-api.ts"
}
```

#### 5.8.4 代理的协调逻辑

1. **需求对齐阶段**：代理分析本项目是否依赖其他项目的能力。如有，写入 `dependencies/<hash>.json`，并将任务分为"可以先做的"和"需要等依赖的"两类
2. **守望循环中**：代理每轮扫描 `capabilities/` 目录和 `messages/` 目录（含全局 CLK 发来的通知），检查自己等待的能力是否有人发布了。发现就绪后，向主控发送新指令，解锁之前 blocked 的任务。如果收到全局 CLK 发来的 `dependency_reminder`（有人在等本项目的能力），向主控发送优先级调整指令
3. **能力发布时机（交付即发布）**：当主控报告阶段完成（`phase_complete`），代理验收通过后，这等同于一次"交付"。代理同时做两件事：
   - 更新项目内部的 ROADMAP/STATE（内部交付）
   - 发布到 `capabilities/<自己hash>/`（跨项目交付）
   - 发布的前提是：所有测试通过 + 代理验收全部 PASS
4. **任务优先级调整**：主控在创建任务时，标记哪些任务 blocked by dependency，这些排在后面。不依赖外部的任务排在前面优先执行。收到代理转发的 `dependency_reminder` 后，可以调整被其他项目等待的能力相关任务的优先级

#### 5.8.5 协调时序

```
项目A代理 → 声明依赖: 需要 crawler.search_api
项目A代理 → 先做不依赖爬虫的 REQ-001、REQ-002、REQ-003
项目B代理 → 开发 search_api
项目B代理 → 发布能力: crawler.search_api@v1 就绪
项目A代理 → 扫描发现能力就绪 → 解锁 REQ-005、REQ-008
项目A代理 → 向主控下发新指令，开始做依赖爬虫的部分
```

#### 5.8.6 被动等待，不主动催促

依赖方不向被依赖方发送催促消息。协调完全基于文件系统的异步扫描：
- 依赖方只管声明自己需要什么，然后先做别的
- 被依赖方完成时发布能力，不需要知道谁在等
- 依赖方在守望循环中自然发现能力就绪

---

## 6. 用户睡觉模式

当用户告知代理"我去睡觉了"时：

1. 代理切换为**自动验收模式**
2. 代理拿出用户的需求文档作为唯一参考
3. 代理不再猜测项目下一步方向，只对照需求文档逐条检查
4. 如果发现某条需求已满足 → 标记完成
5. 如果发现某条需求未满足 → 通知主控优先处理
6. 如果所有需求都满足 → 代理停止分发新任务，等用户回来

代理在睡觉模式下**不做决策**，只做核对。

---

## 7. 报告系统

所有管理角色的输出都写入 `.planning/reports/` 目录：

```
.planning/reports/
  proxy/          ← 代理的决策记录
  controller/     ← 主控的任务分配记录
  supervisor/     ← 超管的审查报告
  clk/            ← CLK 的系统状态报告
  workers/        ← 各工人的工作日志
```

CLK 每 10 个 tick 生成一份综合报告，汇总所有角色的状态。

---

## 8. 技术实现基础

### 8.1 已有基础（gsd-2 Hub 已实现）

- MCP Streamable HTTP 服务端
- SQLite 持久化（session、task、事件、审计）
- Broadcast 消息发布/订阅/轮询
- 任务队列（创建、claim、heartbeat、完成）
- 模块亲和性调度
- Token 用量追踪
- Path 文件租约
- Agent checkpoint 读写
- 安全限流器

### 8.2 需要新增

| 组件 | 说明 |
|---|---|
| 角色管理器 | 管理角色分配、继任、备用池 |
| CLK tick 机制 | 定时广播 + 死锁检测 + 继任触发 |
| Agent 启动器 | 批量创建 tmux CLI session |
| 角色 prompt 模板 | 每种角色的系统指令模板 |
| 睡觉模式切换 | 代理的自动验收逻辑 |
| 活跃度追踪 | 每个 Agent 的最后活动时间记录 |
| Context 使用率监测 | 检测 Agent 是否接近 context 上限 |

### 8.3 部署到新项目/设备

将 `gsd-2/` 文件夹复制到目标项目，然后：

```bash
cd gsd-2
npm install
npm run start          # 启动 Hub
```

代理启动后，在 Cursor 中与代理对话，代理会处理剩余的所有配置。

---

## 9. 数量规划

| 角色 | 数量 | 说明 |
|---|---|---|
| 代理 | 每项目1 | 唯一用户接口（IDE 启动） |
| 主控 | 每项目1 | 唯一指挥中心 |
| 超管 | 每项目1 | 唯一质量监督 |
| CLK | 每项目1 | 项目级系统时钟 |
| 全局CLK | 全局1 | 跨项目统筹，5分钟扫描一次 |
| 工人 | 按需分配 | 按系统资源容量规划 |
| 备用 | 全局共享 | 所有项目共享，哪个项目需要就划给谁 |

**资源上限：CPU + 内存总占用不超过 90%。**

由接最后一棒的助理 Agent 统一规划分配，用户确认后锁定。
备用池是全局冗余，不按项目划分。可用 Agent 越来越少时工作范围收窄，
当某项目只剩 1 个可用 Agent 时停止工作、写 HANDOFF.md 落盘。

---

## 10. 操作规范（所有 Agent 必须遵守）

详细规范见 `knowledge/ref-operational-rules.md`，核心要点：

### 10.1 一次问答原则与交互协议

**核心理念：Agent 的每一次回复要么完成工作，要么通过 AskQuestion 推进。绝不输出纯文字然后停下来等用户。**

- **禁止** Plan → Build 确认流程（中断对话上下文）
- **禁止** SwitchMode 切换到 Plan 模式
- **禁止** 输出问题文字后停下来等用户回复（用 AskQuestion 代替）
- 所有需要用户做选择的场景，必须使用 `AskQuestion` 工具

详见 `knowledge/ref-common-rules.md` §6。

### 10.2 GitHub 仓库必须私有

所有项目创建 GitHub 仓库时，必须使用 `--private` 参数。禁止 public。

### 10.3 网站服务自启动/关闭

涉及 Web 服务时，Agent 必须用 `AskQuestion` 询问用户是否需要：
- 开机自启动（launchd）
- 后台运行
- 端口分配（通过 SOTAgent）

关闭服务时必须完成：停进程 → 删 plist → 释放端口 → 清理文件。

### 10.4 端口统一管理

**任何端口使用必须先向 SOTAgent 申请**，禁止硬编码端口。
通信方式：写 JSON 到 SOTAgent inbox（见 `request-sotagent` Skill）。

### 10.5 SOTAgent 集成

所有项目应通过 SOTAgent 进行端口管理、资源调度、技术同步。
详见 `~/.codex/skills/request-sotagent/SKILL.md`。

### 10.6 需求一致性分析

所有面向用户的最终报告必须包含"需求一致性分析"段落。
AI 可以自主优化方案，但所有变更必须对用户透明。
详见 `knowledge/ref-requirement-consistency.md`。

### 10.7 规范体系分类

gsd-2 中的规范分为两类：
- **流程性**（Procedural）：执行步骤、API 调用、操作规则 → 写在模板和 knowledge/ 中直接执行
- **思想性**（Philosophical）：方法论、设计哲学、架构模式 → 需要 Agent 内化并影响决策

gsd-2 同时承担两类规范的管理，通过 SOTAgent 实现跨项目的规范推送和同步。
先进技术/思想的集成路径：发现 → 分类 → 提炼 → Skill 化 → 装载 → 同步。
详见 `knowledge/ref-norms-taxonomy.md`。

### 10.8 全局安装架构

gsd-2 体系有两层全局安装，确保所有 IDE 窗口和 CLI Agent 使用统一版本：

| 层 | 路径 | 内容 | 更新机制 |
|----|------|------|---------|
| **运行时** | `~/.gsd2/core/` | Hub、scripts、roles 模板等 | git pull + npm install |
| **Skills** | `~/.cursor/skills/gsd2-*` | Cursor IDE 识别的 skill 定义 | 软链接到 `~/Polarisor/gsd-2/.cursor/skills/` |

- **源码仓库**：`~/Polarisor/gsd-2/`（运行时源码）和 `~/Polarisor/gsd-2/.cursor/skills/`（skill 源码）
- **全局 skills 是软链接**：`~/.cursor/skills/gsd2-* → ~/Polarisor/gsd-2/.cursor/skills/`，编辑一处全局生效
- **CLI Agent 和 IDE Agent 共享**同一个 `~/.cursor/skills/` 目录
- **禁止在项目本地安装 gsd-2 运行时**（不再 rsync 或 clone 到 `$(pwd)/gsd-2`）
- 版本检查逻辑在 `gsd2-ide-solo` 的步骤 0 中定义，其他 skill 统一引用全局路径
