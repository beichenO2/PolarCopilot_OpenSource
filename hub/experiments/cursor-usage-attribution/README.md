# Cursor 真实用量归因实验（3×SOLO + 7×全栈）

本目录与 `src/`、`tests/` 自动化用例解耦，仅存放**手工/半自动**实验协议与记录模板。目的：解释「后台（Cursor Usage）里几万 token 从哪来」，区分**本会话必然消耗**与**同账号混桶**。

## 执行边界（重要）

- **Cursor Usage 读数**：没有面向第三方的官方 API；**必须由操作者**在 Cursor 后台（或账单导出）按时间点自行抄录。
- **负载怎么来**：推荐在操作者本机用 **`cursor agent` CLI** 起多个 headless 会话，与仓库里 `scripts/run-phase.sh`、`scripts/launch-system.sh` 的用法一致，例如：
  - `cursor agent --print --yolo --workspace '<项目目录>' '<一段固定 prompt>'`
  - 日志可 `tee` 到文件，便于对照起止时间（见 `docs/observability.md` 中的诊断示例）。
- **Arm A（3×SOLO）**：可用 **3 次**上述 CLI 调用，prompt 固定为同一份文本（本目录提供 `prompts/solo-baseline.txt`：无工具、单行回复，用于**纯对话基线**）；若要对齐真实 SOLO，可另换为带 `$gsd2-ide-solo` 技能头的长 prompt 并单独打标签。**不必**开 IDE 聊天窗也能在 **同一 Cursor 账号** 下产生可对比的用量事件。
- **Arm B（7×全栈）**：优先复用现有 **tmux + `cursor agent`** 的集群启动脚本；仍须记录每套路径、起止时间与 **是否与 Arm A 共用 API Key**。
- **与 IDE 内助手的区别**：若当前对话绑定了 `gsd2-ide-solo` 等技能，技能可能要求 **IDE 内助手不得**在本机代执行 `cursor agent`/新建 tmux；**本实验由操作者在终端执行**，不受该约束。

## 背景假设

| ID | 假设 |
|----|------|
| H1 | 用量主要来自本会话：用户规则、Skill、工具输出、多轮历史。 |
| H2 | 用量来自同账号其它表面：其它 Chat/Composer、Background Agent、第二台设备。 |
| H3 | IDE SOLO 与集群 CLI **共用同一计费密钥**，后台显示为**总和**，误读为「SOLO 悄悄烧」。 |

## 前置条件（必做）

1. **专用 Cursor 账号或专用 API Key**（24h 内不做其它项目），或至少实验窗口内关闭所有其它会话。
2. 实验全程：**仅保留协议允许的窗口**；关闭 Background Agent；不在其它机器登录同一账号。
3. 准备 **UTC 或本地时间戳** 记录表（见 `RECORDING.template.md`）。

## 负载定义（统一口径）

- **短用户消息**：固定一段 ≤500 字的需求文本（写入模板），三轮实验共用同一段。
- **禁止**：首轮故意 `Read` 超大文件；若需基线对比，可另加「带一次小文件 Read」子阶段并单独打标签。

## Arm A — 3×IDE SOLO

1. 新开 **3 个独立** Cursor Chat，均触发 `$gsd2-ide-solo`（或等价单 Agent 模式）。
2. **阶段 A1**：每会话只发 **1 条**短用户消息 → 结束。记录 Cursor Usage 中该时段增量（或会话结束点截图中的数字）。
3. **阶段 A2**（可选）：**同一**会话再发 **5 条**极短 follow-up（各 ≤50 字）→ 再记一次用量。

**期望**：若 A1 即达「几万」，优先对照 skill/规则长度（H1），而非「他人偷用」。

## Arm B — 7×Proxy + Controller + CLK + 工人

1. **密钥隔离（关键）**：若集群走 Cursor CLI 且与 Arm A **共用**同一 API Key，则 Cursor 后台**无法**按「3 个 IDE」拆分用量，结论只能记为 **H3 混桶**。
2. 每套集群：**独立工程目录 + 独立 Hub DB**（与你们现有 launch 流程一致即可）。
3. **固定时长或固定轮数**：例如每套跑满 30 分钟，或脚本循环 `N` 次 MCP 调用；`N` 与起止时间写入记录表。
4. 记录 **脚本/集群 start、stop 时间**，与 Cursor Usage 时间轴对齐。

## 判读表

| 观测 | 倾向 |
|------|------|
| 专用账号、仅 1 个 SOLO 窗口，A1 即有「几万」且与首轮 skill 规模相符 | H1 |
| 关闭其它标签/后台后「不明」用量消失 | H2 |
| 开启 7 路 CLI 后 IDE 后台用量同步上升且与 A 共用 Key | H3 |

## 与 Hub `estimated_tokens` 的关系

集群侧 Hub 内的「token」多为 **MCP 工具次数 × 角色系数** 的估算（见 `src/lifecycle/tracker.ts`），**不是** Cursor 账单数字。本实验以 **Cursor Usage** 为准时，勿与 Hub 面板混读。

## CLI 一键示例（操作者在项目根执行）

Arm A 基线（3 次串行；改 `WORKSPACE` 为你的临时目录或本仓库克隆）：

```bash
# 在 gsd-2 仓库根目录执行
PROMPT="$(cat experiments/cursor-usage-attribution/prompts/solo-baseline.txt)"
WORKSPACE="$PWD"
for i in 1 2 3; do
  echo "=== solo-baseline run $i ==="
  cursor agent --print --yolo --trust --model auto --workspace "$WORKSPACE" "$PROMPT" 2>&1 | tee "/tmp/cursor-solo-baseline-$i.log"
done
```

`--model auto`：避开默认的 Max 档模型（如 `gpt-5.4-xhigh-fast`）在未开 Max 时直接失败。`--trust`：无头模式跳过工作区信任提示。

并行 7 路全栈请使用现有 `scripts/launch-system.sh` / 集群文档中的 tmux 模板，并在 `RECORDING.template.md` 中记录各 session 名与日志路径。

### 故障：`Max Mode Required` / 模型拒绝执行

若 `cursor agent` 立刻打印：

`The model "…" requires Max Mode to be enabled`

说明 **当前 CLI 默认 Agent 模型** 绑在需要 Max 的档位。处理任选其一：

1. 在 **Cursor 应用设置** 中为 Agent / CLI 打开 **Max Mode**（具体菜单以 Cursor 当前版本为准），再重跑本实验。
2. 在 Cursor 里把 **CLI / Agent 默认模型** 改成不要求 Max 的模型后重试。
3. 用 `cursor models`（或 Cursor 文档中的等价命令）查看账号可用模型，并在设置里切换后再跑。

**说明**：在沙箱/无图形环境或未登录完整套餐的机器上，本步常会失败；实验应在与你日常开发 **同一登录状态** 的本机终端执行。

## 文件

- `RECORDING.template.md`：每次实验复制一份，改名为 `RECORDING-YYYYMMDD-运行人.md` 填写。
- `prompts/solo-baseline.txt`：无工具基线 prompt。
