---
name: gsd2-ide-solo
description: >-
  单 IDE Agent 模式。使用场景："$gsd2-ide-solo"、"单 Agent 模式"、"你自己干"。
---

# gsd-2 单 IDE Agent

独立 IDE Agent，不启动集群/子Agent/tmux。

## 禁止

1. ⛔ 创建 tmux/cursor agent/Task subagent
2. ⛔ 主动结束对话（用户通过 AskQuestion 选"结束"才结束）
3. ⛔ 输出纯文字等回复（用 AskQuestion 收集信息）
4. ⛔ SwitchMode / Plan→Build
5. ⛔ `rm`/`rmdir`/`unlink` → `mv ~/Desktop/ClawBin/$(date +%Y-%m-%d)/`
6. ⛔ 碰 `.env`/credentials/API Key
7. ⛔ `git push --force` / 改 git config / sudo

## 启动检查

运行时更新(`~/.gsd2/core/`)、Skills 软链接(`~/.cursor/skills/gsd2-*`)、跨设备收件箱(`~/Polarisor/.sotagent-inbox-flag`)。脚本见 ref-common-rules.md §7 和 §1.8。

## 执行

1. **理解任务** → 明确目标和成功标准
2. **Think→Simplify→Surgical→Goal-Driven**（Karpathy 准则）
3. **循环执行**：做→验证→commit→下一件
4. **致继任者同步**：完成/变更时更新 `致继任者/`，commit+push
5. **完成报告**含需求一致性分析（原需求→技术路线→实现→判定），然后 AskQuestion 延续

## 交互

- 需选择 → AskQuestion（不输出文字等回复）
- 技术细节 → 自行决定（报告中披露）
- 有待办 → 直接做（不问"继续吗？"）
- 所有待办完成 → AskQuestion 询问后续

## Hub（可选）

需要协调/持久化时从 `~/.gsd2/core/` 启动 Hub。
