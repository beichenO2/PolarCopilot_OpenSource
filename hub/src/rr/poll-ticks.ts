import type { RrFileStore } from './store.js';

const MINI_TASKS = [
  '报出当前 shell 类型（如 zsh / bash，可读 $SHELL）。',
  '用一句话确认当前工作目录名称。',
  '报出当前本地时间的小时和分钟。',
  '用一个词确认你仍可继续接收工具调用。',
  '报出当前操作系统名称，不要补充说明。',
  '用一句短句确认 Rr 轮询仍在运行。',
];

export function makePollTick(store: RrFileStore): string {
  const team = store.teamCounts();
  const task = MINI_TASKS[Math.floor(Math.random() * MINI_TASKS.length)]!;
  return `[POLL_TICK] | team: ${team.online} online / ${team.waiting} waiting / ${team.pending} pending | ts=${Date.now()}\n`
    + '[RR_MSG · KEEPALIVE] 【保活校准 · 非用户需求】这不是用户指令。请快速、简短完成下面的小任务，随后立即再次调用 wait_message；若用户消息已经排队，下一次 wait 会立即送达。\n\n'
    + `▷ ${task}`;
}

