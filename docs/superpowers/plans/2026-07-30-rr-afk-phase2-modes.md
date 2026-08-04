# Rr AFK Phase-2 · 三模式接线 + 交叉验证门禁

> **状态：DONE（2026-07-30）** · 总板见 [`2026-07-30-rr-afk-STATUS.md`](./2026-07-30-rr-afk-STATUS.md) · 下一阶段 Phase-4（合入 / Go 硬拦 / 真机短跑）。  
> 承接 [Rr AFK SSoT refactor](file://~/.cursor/plans/rr_afk_ssot_refactor_6a2655f0.plan.md)（Phase-1 todos 全完成）。  
> 纪律：`using-superpowers` · `verification-before-completion` · 每单元 **A 实现 → B 交叉审查** 后才进下一单元。

## 现状

| 层 | 状态 |
|----|------|
| Phase-1 SSoT / CLI / UI / 删 codex-afk / 单测 | 已落地 |
| Skills：`afk` 路由 + `afk-start` / `afk-solo` / `afk-go` + `infinite-mcp.md` | 已落地；U1 B 复审 GO |
| Hub/CLI `mode=start\|solo\|go` | U2 已落地；B 复审 GO；`tests/rr` 127 通过 |
| `allowNewSubagents` + go planner 硬门闩 | 已落地（go 关新建/忽略 autoDispatch） |
| U3 UI mode 选择 | 已落地；B GO（含 oneClick 后同步 config） |
| U4 验证收口 | **完成**（web tsc + hub 127 + sync + API 400） |
| 交叉验证门禁 | 已制度化（A→B） |

## 目标

1. `pc afk start --mode start|solo|go` ≡ Hub `POST .../one-click` body.`mode`
2. mode 语义落地：
   - `start`：不强制 never-ask；不强制关 Subagent（保持面板现状）
   - `solo`：首 inject 声明 Mode=solo；Subagent 遵循面板/预算
   - `go`：PATCH `allowNewSubagents=false`；spawn `subCount=0`；首 inject 绑定 `infinite-mcp` 纪律 + 禁 dispatch 开池
3. 任务 `summary`/`state` 记录 `mode`
4. 每个落地单元：A（实现模型）完成后 B（审查模型）出缺陷清单；Critical/Important 修完再继续
5. 证据门禁：hub `tests/rr` + sync-skills 双端 realpath + 相关 API 手测摘要

## 非目标

- 不重开 Codex AFK
- 不改 PolarProcess 全局 maxConcurrent 产品语义
- 不覆盖用户无关脏改动

## 单元拆解

### U1 · Skills 交叉审查（B）
审 `afk*` skill 与 Hub 现实是否矛盾（尤其 infinite-mcp、go 的 OFF 门闩、路径）。

### U2 · mode 接线（A → B）
- `afk-service.oneClickAfk({ mode })`；summary/state 记 `mode`
- `pc-cli` `--mode start|solo|go`；router / web API 类型
- **`mode=go` 验收扩大（B U1 强制）**：
  1. `PATCH /api/ui/rr/config` → `allowNewSubagents=false` 并复核（正确路径）
  2. spawn / 新建进程语义 `subCount=0`
  3. **关闭/忽略 `autoDispatchSubagents`**（planner 不得因调研 TODO 自动派子）
  4. 首 inject **硬写**禁止 `list_subagents`/`dispatch_subagent_task` + Mode=go + infinite-mcp 要点
  5. 若 MCP dispatch 暂不硬拦：测试覆盖 inject 禁令文案；文档诚实声明
- 测试：solo/start 不误关 Subagent；go 满足上列 1–4

### U3 · UI 轻量（可选同批）
一键 AFK 旁 mode 选择或默认 solo；go 时展示「禁止新 Subagent」已锁定提示。

### U4 · 验证收口
跑测 + sync + Hub status；交付附命令输出。

## A/B 模型约定（本仓库惯例）

| 角色 | 建议模型 | 职责 |
|------|----------|------|
| A | `composer-2.5-fast` | 实现 + 单测 |
| B | `cursor-grok-4.5-high-fast` | 只读审查；结论带路径/行号/命令证据 |

B 禁止「看起来没问题」；必须列 Critical / Important / Minor 或明确「无阻断」。
