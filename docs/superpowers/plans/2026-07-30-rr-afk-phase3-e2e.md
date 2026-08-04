# Rr AFK Phase-3 · 端到端验收门禁（E2E / 冒烟）

> **状态：DONE（2026-07-30）** · 总板见 [`2026-07-30-rr-afk-STATUS.md`](./2026-07-30-rr-afk-STATUS.md) · 下一阶段 Phase-4。  
> 承接 Phase-2（三模式接线 U1–U4 已 GO）。  
> 纪律：`using-superpowers` · `verification-before-completion` · 夜挂机 `completion-criteria`（**必须含面向用户/端到端检查**）· 发版 `mock-smoke`（先健康再关键路径）· 每单元 **A 实现 → B 交叉审查**。  
> 冻结判据：`docs/superpowers/plans/2026-07-30-rr-afk-phase3-CRITERIA.md`（本文件引用，禁止自行放软）。

## 为什么要 Phase-3

Phase-2 U4 只证明了：单元测试 + sync-skills + 少量 API 手测。按夜挂机验收规范：

> 至少包含一条**面向用户/端到端**的检查，不能只有静态检查（typecheck 过 ≠ 业务对）。

当前缺口：没有可复跑的 E2E/冒烟脚本覆盖「一键 AFK × mode」用户可见路径。

## 目标

1. 冻结 E2E 判据（本轮写死，之后不自行改软）
2. 落地两层冒烟（对齐 mock-smoke）：
   - **L1 进程内 HTTP E2E**（vitest，临时 root，可 CI）：mode 校验 / go 配置副作用 / inject 文案 / status.summary.mode
   - **L2 真 Hub 冒烟**（对 `:8040`）：health → 受影响 API 契约 → `/pc/rr` UI 含 mode 选择文案；**不**在冒烟里强制真实 spawn Cursor Agent（避免污染用户会话）；负向：`spawnIfNeeded=false` 且无主会话 → `no_master_session`；非法 mode → 400
3. A→B 交叉验证；Critical/Important 修完再收口
4. 交付附本轮新鲜命令输出；缺 E2E 证据不得宣称 Phase-3 DONE

## 非目标

- 不真实拉起长时间 Cursor Agent 跑业务（那是 AFK 运行时，不是发版冒烟靶）
- 不生产灰度 / 不防逆向加固（release-preflight 第 5–6 关标 N/A：本地 Hub 工具链）
- 不重开 Codex AFK

## 单元拆解

### U0 · 冻结判据（本文件 + CRITERIA.md）
写出可跑检查清单；覆盖正常 + 关键异常。

### U1 · L1 进程内 E2E（A → B）
新增 `hub/tests/rr/afk-mode-e2e.smoke.test.ts`（或等价），用临时 store/root + 真实 router listen(0)，覆盖：
- `POST .../one-click` `mode=bogus` → 400 `invalid_afk_mode`
- `mode=go`（mock spawn / 复用已有主会话）→ summary.mode=go；config `allowNewSubagents=false`；首 inject 含禁止 dispatch / Mode=go
- `mode=solo|start` → 不强制关 Subagent
- `GET .../afk/status` 能读到 summary.mode

### U2 · L2 真 Hub 冒烟脚本（A → B）
新增 `hub/scripts/smoke-afk-modes.sh`：
1. Hub health
2. `GET /api/ui/rr/afk/status` 契约（ok/active/summaries 字段存在）
3. `GET /api/ui/rr/config` 可读
4. `POST one-click` invalid mode → 400
5. `POST one-click` `{spawnIfNeeded:false, mode:solo}` 无主会话时期望业务错误（非 5xx）
6. `GET /pc/rr`（或静态资源）响应体含 `协作 start` / `自治 solo` / `Go 单主` 之一（证明 UI 制品含 mode 选择）
7. 退出码：任一步失败非 0；打印 ❌ 且 exit 0 视为作弊、门禁失败

### U3 · 验证收口 + B 总审
- `vitest run tests/rr`（含新 E2E）全绿
- `bash hub/scripts/smoke-afk-modes.sh` 对真 Hub 全绿
- web `tsc --noEmit`
- sync-skills 双端 realpath
- B 出 GO/NO-GO；无 Critical/Important 未修项才 DONE

## A/B 约定

| 角色 | 模型 | 职责 |
|------|------|------|
| A | `composer-2.5-fast` | 实现测试/脚本 |
| B | 本会话 Grok | 只读审查 + 证据门禁；列 Critical/Important/Minor |

## 进度

| 单元 | 状态 |
|------|------|
| U0 冻结判据 | 完成 |
| U1 L1 E2E | 完成；B GO（含 C6 不回落主会话加固） |
| U2 L2 Hub 冒烟 | 完成；B GO（bogus sessionId + 断言 no_master_session） |
| U3 收口 | **完成** — hub rr 133 + smoke PASS + web tsc 0 |
