# 方案 C：Web UI 替代 AskQuestion

## 目标

当 Agent 需要用户输入时，不使用 Cursor 的 AskQuestion（产生额外 API 请求），而是通过 Hub 的 Question 协议 + 轻量 Web UI 收集用户回复，Agent 在**同一个 agent step** 内轮询等待结果。

## 架构

```
Agent (Cursor)                    Hub (HTTP)                Web UI (Browser)
    |                                |                          |
    |-- POST /question ------------->|                          |
    |   {prompt, options}            |-- store to SQLite ------>|
    |                                |                          |
    |-- GET /question/:id/poll ----->|   (Agent 在 Shell 中     |
    |   (sleep+retry loop)           |    用 curl 轮询)         |
    |                                |                          |
    |                                |<-- GET /ui/questions ----|
    |                                |   (用户打开浏览器看到问题) |
    |                                |                          |
    |                                |<-- POST /question/:id ---|
    |                                |   {answer: "option_a"}   |
    |                                |                          |
    |<-- 200 {answer: "option_a"} ---|                          |
    |                                                           |
    |(Agent 在同一 step 继续执行)                                 |
```

## 关键：为什么能省请求

AskQuestion 的成本来自 Cursor 的执行模型：
1. Agent 调用 AskQuestion → Cursor 暂停 Agent → 展示 UI 给用户
2. 用户选择 → Cursor **发新的 API 请求**恢复 Agent

而 Web UI 方案中：
1. Agent 在 Shell 中运行 `curl` 轮询 Hub
2. 用户在浏览器中回答
3. Hub 返回答案 → Agent 在**同一个 Shell 工具调用内**得到结果
4. **不产生新的 API 请求**

## 实现要点

### 1. Hub 侧：已有 Question 协议

Hub 的 `src/questions/service.ts` 已实现完整的 Question 生命周期：
- `submitQuestion` → 提交问题
- `claimQuestion` → 认领问题
- `submitAnswer` → 提交答案
- `getQuestion` → 查询状态

只需增加：
- 一个简单的 HTML 页面（可以是 Express 静态路由）
- 一个 `/api/ui/pending-questions` endpoint 返回待回答的问题
- 一个 `/api/ui/answer` endpoint 接收用户回答

### 2. Agent 侧：轮询脚本

```bash
# Agent 提交问题
QUESTION_ID=$(curl -s -X POST "http://localhost:$HUB_PORT/api/ui/question" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"选择方案","options":["A: ...","B: ...","C: ..."]}' | jq -r '.question_id')

# 轮询等待回答（在同一个 Shell step 中）
while true; do
  ANSWER=$(curl -s "http://localhost:$HUB_PORT/api/ui/question/$QUESTION_ID" | jq -r '.answer // empty')
  if [ -n "$ANSWER" ]; then
    echo "用户选择: $ANSWER"
    break
  fi
  sleep 3
done
```

这整个过程是一个 Shell 工具调用，不会产生额外的 API 请求。

### 3. Web UI：极简前端

一个单 HTML 文件（内联 CSS/JS），展示：
- 待回答的问题列表
- 每个问题的选项按钮
- 点击后 POST 回 Hub

不需要 React/Vue/build pipeline。纯 HTML + fetch API。

## 成本分析

| 方案 | 每次用户交互的额外 API 请求 | 额外 tokens |
|------|---------------------------|------------|
| AskQuestion | 1 个恢复请求 | 3-5 万 |
| Web UI 轮询 | 0 个 | 0（curl 在 Shell step 内） |

一个 session 3 次交互：AskQuestion 多花 ~10-15 万 tokens，Web UI 为 0。

## 局限

1. 需要 Hub 运行中（SOLO 模式通常不启动 Hub）
2. 用户需要打开浏览器查看问题（不如 AskQuestion 在 IDE 内直观）
3. Shell 轮询期间 Agent step 不会结束，但 Cursor 有 `block_until_ms` 超时

## 折中方案

不启动完整 Hub，用**文件轮询**替代：

```bash
# Agent 写问题到文件
cat > /tmp/gsd2-question.json << 'EOF'
{"prompt":"选择方案","options":["A","B","C"]}
EOF
echo "⏳ 请在另一个终端运行: echo 'A' > /tmp/gsd2-answer.txt"

# 轮询等待
while [ ! -f /tmp/gsd2-answer.txt ]; do sleep 2; done
ANSWER=$(cat /tmp/gsd2-answer.txt)
echo "用户选择: $ANSWER"
```

更简单，不依赖 Hub，但 UX 差很多。

## 推荐路径

1. **短期**：方案 B（减少 AskQuestion）+ 方案 A（精简 Skill）→ 立即见效
2. **中期**：跑实验（方案 D）量化真实差异
3. **长期**：如果实验证实 AskQuestion 开销显著，实现 Web UI 方案
