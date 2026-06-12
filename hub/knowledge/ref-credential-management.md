# 凭证管理规范

## 核心原则

**⛔ 绝对禁止将任何凭证（API Key、Token、Password）以明文写入 git 仓库。**

所有敏感凭证必须通过 PolarPrivate (PrivPortal) 集中管理。

## PolarPrivate 凭证管理

**位置**: `~/Polarisor/PolarPrivate/`

### Secret 类型（运行时密钥）

以下凭证必须存入 PolarPrivate 的 Secret vault：

| 服务 | Secret 名称规范 | 说明 |
|------|----------------|------|
| DashScope LLM | `llm.aliyun.codingplan` | CodingPlan API Key（统一 LLM 入口） |
| Telegram Admin Bot | `telegram.admin` | 管理员 Bot Token |
| Telegram GF Bot | `telegram.girlfriend` | 女友 Bot Token |
| 飞书 Admin App | `feishu.admin.secret` | 管理员飞书应用 App Secret |
| 飞书 GF App | `feishu.girlfriend.secret` | 女友飞书应用 App Secret |
| Ollama | `local.ollama` | 本地 LLM（通常无需密钥） |

### Identity 类型（文档类信息）

以下信息存入 PolarPrivate 的 Identity：

| 字段 | 说明 |
|------|------|
| `feishu.admin.appId` | 管理员飞书应用 App ID |
| `feishu.admin.verifyToken` | 管理员飞书应用 Verification Token |
| `feishu.girlfriend.appId` | 女友飞书应用 App ID |
| `feishu.girlfriend.verifyToken` | 女友飞书应用 Verification Token |

### Binding 配置

通过 PolarPrivate 的反向代理功能，PolarClaw 可以通过本地端点访问外部 API：

```
http://127.0.0.1:12790/proxy/llm.aliyun.codingplan/chat/completions
```

密钥自动注入 Authorization header，PolarClaw 代码中无需接触明文。

## .env 文件规范

各项目的 `.env` 文件：

1. **必须**在 `.gitignore` 中
2. **可以**临时存放凭证（开发阶段）
3. **生产部署时**应通过 PolarPrivate 的 Binding/Proxy 替代
4. **绝不**commit 到 git

## Agent 行为规范

**⛔ 所有隐私信息、凭证、Token 必须走 PolarPrivate，无例外。**

1. **任何**新获取的 API Key、Token、密钥 → 立即存入 PolarPrivate Secret vault
2. **任何**涉及身份的信息（App ID、用户名等）→ 存入 PolarPrivate Identity
3. 创建新项目时检查 `.gitignore` 是否包含 `.env`
4. 临时写入 `.env` 前，确认该文件在 `.gitignore` 中
5. Commit 前检查 diff 中不包含敏感信息
6. 对用户提供的凭证，不在日志、回复或 commit message 中暴露
7. **绝不**直接向用户索要凭证明文 — 引导用户自行存入 PolarPrivate
8. 代码中读取凭证时，优先通过 PolarPrivate reveal API 或 Binding Proxy
9. 如 PolarPrivate 不可用（未启动），使用 `.env` 作为降级方案，但必须告知用户

### Secret 命名规范

新增第三方服务的 Secret 命名格式：`secret.{provider}.{service}.{field}`

示例：
- `secret.opentwitter.api_token` — OpenTwitter MCP 访问 Token
- `secret.aliyun.CodingPlan.api_key` — 阿里云 Coding Plan API Key
- `secret.telegram.admin.bot_token` — Telegram 管理员 Bot Token
