# 实验：AskQuestion 请求成本量化

## 目标

精确测量 AskQuestion 交互在 Cursor 按次/token 计费中产生的额外成本。

## 前置条件

1. Cursor 账号处于可追踪用量的状态（Usage 页面可查看）
2. 实验期间关闭所有其他 Cursor 窗口/Chat/Background Agent
3. 记录开始前的 Usage 基线

## 实验组

### Arm 1: 无 AskQuestion 基线

**Prompt**（新开 Chat，不附加任何 Skill）：

```
Read the file package.json in this workspace, then reply with a one-sentence summary of what this project does. Do not use AskQuestion. Do not ask for confirmation. Just do it and stop.
```

预期：Agent 读文件 → 回复 → 停止。约 2-3 个 API steps。

记录 Usage 增量。

### Arm 2: 带 1 次 AskQuestion

**Prompt**（新开 Chat，不附加任何 Skill）：

```
Read the file package.json in this workspace. Before answering, use the AskQuestion tool to ask me which format I prefer: (A) bullet points, (B) one sentence, (C) JSON. After I choose, give me the summary in that format.
```

预期：Agent 读文件 → AskQuestion → 用户选择 → 恢复请求 → 回复。约 4-5 个 API steps。

记录 Usage 增量。

### Arm 3: 带 3 次 AskQuestion

**Prompt**（新开 Chat，不附加任何 Skill）：

```
Read the file package.json in this workspace. I want a project summary, but first:
1. Use AskQuestion to ask what format (bullet/sentence/JSON)
2. After I answer, use AskQuestion to ask how detailed (brief/medium/comprehensive)
3. After I answer, use AskQuestion to ask what language (English/Chinese)
4. Then produce the summary matching all my choices
```

预期：约 7-9 个 API steps。

记录 Usage 增量。

### Arm 4: 带 GSD2 SKILL（完整 solo 模式）

**Prompt**（附加 `gsd2-ide-solo` Skill）：

```
/gsd2-ide-solo Read package.json and give me a one-sentence summary.
```

预期：SKILL 加载 + 版本检查 + 执行 + 完成报告 + AskQuestion。约 10-15 个 API steps。

记录 Usage 增量。

## 记录表

| Arm | 开始 Usage | 结束 Usage | 增量(tokens) | 增量(requests) | 耗时 | 备注 |
|-----|-----------|-----------|-------------|---------------|------|------|
| 1   |           |           |             |               |      |      |
| 2   |           |           |             |               |      |      |
| 3   |           |           |             |               |      |      |
| 4   |           |           |             |               |      |      |

## 分析方法

1. `Arm2 增量 - Arm1 增量` = 1 次 AskQuestion 的成本
2. `Arm3 增量 - Arm1 增量` / 3 = 每次 AskQuestion 的平均成本
3. `Arm4 增量 - Arm1 增量` = GSD2 SKILL 加载 + 交互协议的总开销
4. 如果 Arm2-Arm1 差异很小 → AskQuestion 不是主要成本来源 → 重点看 Arm4

## 预期结果

- Arm1: ~50,000-100,000 tokens (基线)
- Arm2: ~80,000-150,000 tokens (多 1 个恢复请求)
- Arm3: ~150,000-250,000 tokens (多 3 个恢复请求)
- Arm4: ~300,000-500,000 tokens (SKILL overhead 占大头)

如果 Arm4 >> Arm3，说明 SKILL 体积是主要问题（方案 A 优先）。
如果 Arm3 >> Arm2，说明 AskQuestion 累积是主要问题（方案 B/C 优先）。
