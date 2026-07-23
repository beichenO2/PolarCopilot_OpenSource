# XJ-Cursor 紧急隔离设计

日期：2026-07-24  
状态：待书面规格复核后实施  
目标：保留 XJ 的账号、NoQuota、联网和普通面板能力，立即停止 Prompt 注入、请求上下文改写和 MCP 生命周期绕过。

## 1. 已确认根因

XJ 当前存在三条独立注入路径：

1. `workbench.desktop.main.js` 中的 `CURSOR_AGENTRULES_NP_START/END` 包装器，在每次请求构造完成后向 `requestContext.rules` 追加 `engineering-standards`。
2. `xj-chat` 启动 bubble 强制 Agent 进入 `register_session → wait_message → reply_message` 循环。
3. MCP 工具描述和返回值包含 `MUST`、`NEVER`、立即再次等待等行为命令。

另有四处 Cursor 核心补丁：create client 去重、full lease 通知短路、unsubscribe grace 从 30 秒延长到 24 小时、sandbox policy 变化处理短路。

## 2. 方案选择

采用已批准的 A 方案：紧急隔离 XJ 对话/MCP 注入面，保留非对话在线能力；随后由 PolarCopilot 提供干净兼容实现。

### 保留

- XJ 扩展本体及登录/账号在线状态。
- NoQuota 与普通信息面板。
- XJ 已有本地会话取证数据 `~/.xj-cursor/chat/`，不删除、不改写。
- `product.json` 和 `*.cursor-cost.bak` 所属的成本功能改动暂不还原，因为用户明确要求保留 NoQuota；因此本次不承诺恢复 Cursor 官方代码签名。

### 关闭

- XJ 规则同步与内嵌 `engineering-standards`。
- 无限 MCP 核心补丁及其周期安装路径。
- `xj-chat` MCP 注册项和 XJ 对话入口的实际使用。
- XJ 自动安装更新，防止未审计版本重新开启注入；保留更新检查，改为人工决定是否安装。

### 不做

- 不删除 XJ 扩展、账号或许可证状态。
- 不删除历史会话、inbox、history 或 session 映射。
- 不篡改 Cursor 会话数据库来抹去既有证据。
- 不复制、导出或修改卡密、令牌、账号池凭证。

## 3. 实施顺序

### 3.1 建立可回滚快照

在 `~/Desktop/XJ/hotfix-backup-<timestamp>/` 保存：

- Cursor `settings.json`；
- `~/.cursor/mcp.json`；
- 三个被 XJ 修改的 Cursor 核心 JS；
- 对应 `.cursor-mcp.bak` 与 `.cursor-cost.bak`；
- 文件 SHA-256、mtime、大小和当前 `codesign` 输出。

备份只包含本机配置与应用资源，不复制凭证值到报告。备份目录权限限制为当前用户。

### 3.2 关闭扩展侧重注入开关

在 Cursor 用户设置中显式写入：

```json
{
  "xjCursor.rules.enabled": false,
  "xjCursor.mcpStable.enabled": false,
  "xjCursor.update.autoInstall": false
}
```

保留 `xjCursor.update.autoCheck=true` 和 XJ 服务器配置。

### 3.3 隔离 `xj-chat`

从 `~/.cursor/mcp.json` 删除 `mcpServers.xj-chat`，原对象保存在回滚快照中。其他 MCP 配置逐字保留，不做格式化重写以外的无关变更。

结果：XJ 的 stdio server 不再被 Cursor 自动加载，工具描述/返回值和启动 bubble 无法进入新会话。`~/.xj-cursor/chat/` 数据继续保留，后续供 PolarCopilot 兼容迁移。

### 3.4 还原请求上下文与 MCP 生命周期

只做带标记、可断言的定点替换：

- 删除 `CURSOR_AGENTRULES_NP_START/END` 包装器和内嵌规则数组，恢复原始 `this.remoteExecutor.execute(...)` 调用；
- 撤销 desktop/glass 两处 `CURSOR_MCP_CREATE_DEDUPE`；
- 撤销 desktop/glass 两处 `CURSOR_MCP_LEASE_GUARD`；
- 将 `CURSOR_MCP_UNSUB_GRACE` 从 24 小时恢复到备份中的 30 秒参数；
- 删除 `CURSOR_MCP_SANDBOX_GUARD` 的入口 `return`，恢复 network-controls policy 变化时的正常 stdio MCP 重载。

每个替换在写入前必须满足：目标标记恰好出现预期次数、旧片段与 `.cursor-mcp.bak` 或 `.cursor-cost.bak` 对照一致。断言失败则停止，不做部分写入。

不得整文件覆盖 `workbench.desktop.main.js`：其 `.cursor-mcp.bak` 已包含旧版 0x001–0x007 规则注入，直接复制会重新引入更大的 Prompt。

### 3.5 完整退出并重开 Cursor

磁盘修复完成后，通过 Cursor 自身的正常退出流程完整关闭，再重新打开。仅重载窗口不足以保证旧的 extension host、renderer 和 mcp-process 全部退出。

退出前不得丢弃未保存编辑。若 Cursor 拒绝退出或出现保存确认，停止自动操作并交由用户确认。

旧的 XJ 污染会话继续包含历史 bubble；它只作为证据保留，不再继续使用。重开后创建新 Cursor 会话进行验证。

## 4. 验证标准

### 静态验证

- 三个核心 JS 中不存在 `CURSOR_AGENTRULES_NP_*` 和四个 `CURSOR_MCP_*` 标记。
- Cursor 设置中的三个隔离开关值正确。
- `mcp.json` 不含 `xj-chat`，其他 MCP server 集合与备份相比完全一致。
- `~/.xj-cursor/chat/` 的目录和已有数据未变化。

### 重启后验证

- XJ 扩展仍能打开普通面板并访问保留的在线功能。
- 新 Cursor 会话没有 XJ 启动 bubble。
- 新请求构造链不再追加 `engineering-standards`。
- Cursor MCP 列表不再出现 `xj-chat`。
- XJ 日志不再出现新的规则装载或 `McpStable install.begin` 成功写入证据。
- 正常 MCP 在 network-controls policy 变化路径上的代码不再被入口 `return` 短路。

### 已知边界

- 因保留 NoQuota 的成本功能改动，`codesign --verify` 仍可能因 `product.json` 或 cursor-cost 资源变更失败；报告必须明确列出剩余修改，不得宣称 Cursor 已恢复官方签名。
- 不截获加密网络载荷；验证以会话 bubble、transcript、请求上下文代码、MCP 清单和运行日志为准。

## 5. 回滚

任一步失败时：

1. 不重开 Cursor；
2. 从本次时间戳快照恢复被触及文件；
3. 对恢复结果重新计算 SHA-256；
4. 若 Cursor 已退出，则仅在恢复完成后重新打开；
5. 报告失败断言和未执行步骤，不继续叠加修复。

## 6. 后续 PolarCopilot 兼容复刻

紧急隔离验收后单独设计第二阶段：

- 在现有 PolarCopilot Hub 上增加 XJ session/history/inbox 兼容适配器；
- 复用 `SessionRegistry`、SQLite events/cursors、SSE 和现有 React/Tailwind UI；
- 由客户端状态机负责等待、重连和恢复，不向模型注入无限循环 Prompt；
- 新增与现有 Layout/Nav/token 一致的 Sessions/MCP 页面；
- 保持协议与 UI 可替换，不修改 Cursor 应用核心。

第二阶段作为独立设计、实施计划和测试闭环，不与紧急热修复混改。
