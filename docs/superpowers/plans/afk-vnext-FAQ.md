# AFK vNext · 澄清（对你刚才的问题）

## 1. PolarProcess 注册失败是 skill 没写清吗？

**两件事，别混：**

| 原因 | 谁的锅 |
|------|--------|
| Python heredoc 里写了 shell 的 `$ID1`，被 bash 先展开成空 | **我（Agent）写命令写砸了**，不是 PolarProcess |
| `register` body 里的 `env` **没有**可靠注入到 `start.sh` | **PolarProcess / runtime-governance skill 没写死这条**；合同只强调 `start_script_dir` + 前台 `start.sh`，没说「参数必须写进 `command` 字符串」 |

正确用法（已落地）：

- **一个** `Start/afk-cli/start.sh`
- 参数放进 `command`：`bash Start/afk-cli/start.sh '<chatId>' '<prompt>'`
- 服务 id 用 ephemeral 前缀：`cursor-cli-afk-<…>`，结束后 `DELETE /api/services/:id` 自动清掉

## 2. 大家都是脚本启动 cursor-cli 吗？要 N 个脚本吗？

- **Web / 无头路径**：是，经 PolarProcess → 前台脚本 → `cursor-agent`（官方要求不裸起持久进程）。
- **IDE 路径**：不是。用户开 Agent tab，当前对话就是 executor；靠 stop hook `followup_message` 续跑，**不**为每个 IDE tab 建 PolarProcess。
- **N 个 Agent ≠ N 个 start.sh**。共享一个 `Start/afk-cli/start.sh`，N 次注册只是 N 条 **command 参数不同** 的 ephemeral 服务行。

## 3. 结束后要不要自动删残留？

**要。** 已实现：`hub/scripts/afk-cli-run-once.mjs`  
register → start → 等到 stopped → `DELETE`（`cursor-cli-*` 无需 confirm）。  
误注册的 `afk-cli-smoke-*` 已用 `confirm` 删掉。

## 4. MCP 物理移除？

**不做。** 那是别的项目的清单，跟本 AFK vNext 验收无关。  
产品路径：再开一个 tab，标题/焦点叫 **afk** 即可；保留你现有 MCP。

## 5. 删 ACTIVE / PAUSE / DONE「真源」是啥？

以前状态靠仓库外几个**空旗标文件** + `index.json` 记「谁在跑」：

- `~/.rr-cursor/afk/ACTIVE`（或旧 `~/.cursor/afk/ACTIVE`）有文件 ≈ 有人在挂机  
- `PAUSE` / `DONE` 同理  
问题：它们能**同时存在**、和 `index.json` 打架，出现「已完成还显示 active」。

「删真源」= **以后只信 SQLite**（`~/.polar-copilot/afk/afk.db`），这些文件最多当考古/迁移，**不再用来判定任务是否在跑**。  
不是删你的代码仓库，也不是今天必须你手动 rm。等 SQLite 稳定后再做；你不懂可以忽略，说「先别动文件系统」我就不动。

## 6. `/loop` 能不能替你操作 IDE tab？

**不能注入别的 IDE 对话。**

| 机制 | 实际能力 |
|------|----------|
| `/loop` | 只唤醒**当前这个** Agent 会话（shell sentinel），不是开第二个 Cursor tab、也不能往别人对话里打字 |
| stop hook `followup_message` | 续跑**已经在跑的**那条 conversation |
| `cursor-agent create-chat` + `--resume` | 自动化无头「两路 AFK」——这才是我能完全代劳的双路证明 |

所以：IDE 里「开一个叫 afk 的 tab」仍是你点一下标题的 UX；**双路执行隔离与 resume** 我用 CLI/PolarProcess 自动化完成。
