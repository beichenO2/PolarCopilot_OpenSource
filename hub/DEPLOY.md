# gsd-2 部署

## 使用方法

在 Cursor IDE 里打开你的项目，开一个 Chat，发送：

```
阅读 gsd-2/src/roles/proxy-prompt.template.md 然后按指令执行每一步。
```

如果项目里还没有 gsd-2，先 clone：

```
git clone https://github.com/beichenO2/gsd-2.git
```

然后发送上面那句话。**AI 会自己搞定剩下的一切：** 安装依赖、启动 Hub、问你需求、启动工人、开始干活、永不停止。

---

## 它会做什么

AI 收到 prompt 后按 6 个阶段自动推进：

| 阶段 | 做什么 | 你要做什么 |
|---|---|---|
| 0. 环境准备 | 检测/更新 gsd-2、npm install、启动 Hub | 无 |
| 1. 注册 | 代理注册到 Hub | 无 |
| 2. 理解需求 | 分析项目，AskQuestion 问你 | 回答问题 |
| 3. 启动集群 | tmux 里启动 N 个工人 Agent | 确认数量 |
| 4. 设计文档 | 生成 PROJECT/REQUIREMENTS/ROADMAP | 确认设计 |
| 5. 守望循环 | 委托主控→守望轮询→验证→最后一棒 | 偶尔回答 |

---

## 前提条件

| 依赖 | 版本 | 安装 |
|---|---|---|
| Node.js | 22+ | `brew install node` |
| tmux | 3+ | `brew install tmux` |
| Cursor | 最新 | [cursor.com](https://cursor.com) |
| git | 任意 | 系统自带 |

---

## 常用操作

```bash
# 查看本项目的 Agent（g-<hash>- 前缀）
./gsd-2/scripts/cluster-status.sh

# 进入某个 Agent（Ctrl-b d 退出）
tmux attach -t g-<hash>-w001

# Hub 日志
tail -f .planning/logs/hub.log

# 查看全局锁状态
./gsd-2/scripts/global-lock.sh status

# ⚠️ 禁止使用 tmux kill-server！
# ⚠️ 全局锁定后禁止关闭 Agent！
# 紧急情况:
./gsd-2/scripts/stop-cluster.sh --force
```

---

## 版本管理

AI 在阶段0会自动检测 gsd-2 版本，如果落后于 GitHub 则自动覆盖更新。

手动更新：
```bash
cd gsd-2 && git pull origin main && npm install
```
