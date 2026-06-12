# Agent 生命周期管理经验

> 来源：hub/.planning/HANDOFF.md（2026-04-10 修复交接）中的已验证做法

## 指数退避重启

Agent 进程非正常退出时使用指数退避（5s → 10s → 20s → ... → max 300s），正常退出（runtime > 2min）重置为 5s。60s 内超过 10 次重启触发 5 分钟强制休眠。每次重启写入 `.planning/agent-state/<agent>.json` 状态文件。

## 重复创建保护

启动前检查 tmux session 是否已存在 + 检查 `.planning/agent-state/launched.json` 启动标记。已有 Agent 运行时跳过创建。

## 重启恢复上下文

非首次启动时在 prompt 后附加恢复提示，告知 Agent 跳过初始化步骤直接进入工作循环。

## Hub 调用超时

所有 `hub-call.sh` 调用加 `--connect-timeout 5 --max-time 30`。

## Agent 循环强化

Prompt 模板明确写"你是常驻服务不是一次性脚本"，具体的 sleep + 继续 poll 步骤，"你的下一个动作永远是调用 Shell 工具"。Work loop 增加 NEVER EXIT 标注和 sleep 10 步骤。

## 备用池启动

自动创建 standby agents（NUM_WORKERS/5，最少 2 最多 10 个），自动分配 reserve 角色，解决 CLK succession "no reserves available" 问题。
