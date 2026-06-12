# 端口治理规范

## 核心规则

1. **所有通信端口必须通过 SOTAgent 申请**，禁止硬编码或自行选择端口
2. **端口号必须以 0 或 5 结尾**（如 4800, 4805, 8790），SOTAgent 会拒绝不合规的申请

## 申请方式

### 方式一：HTTP API（推荐）

SOTAgent 运行时通过 REST API 申请：

```bash
# 读取 SOTAgent API 端口
SOTAGENT_PORT=$(python3 -c "import json; print(json.load(open('$HOME/.sotagent/ports.json'))['sotagent_api'])")

# 申请端口（可指定偏好端口）
curl -s "http://127.0.0.1:${SOTAGENT_PORT}/api/ports/allocate" \
  -X POST -H "Content-Type: application/json" \
  -d '{
    "service_name": "my-service",
    "project": "my-project",
    "preferred_port": 5500,
    "range_start": 3000,
    "range_end": 9995
  }'
# 返回: {"ok":true,"port":5500,"service_name":"my-service","project":"my-project"}

# 释放端口
curl -s "http://127.0.0.1:${SOTAGENT_PORT}/api/ports/release" \
  -X POST -H "Content-Type: application/json" \
  -d '{"port": 5500}'

# 查询所有已分配端口
curl -s "http://127.0.0.1:${SOTAGENT_PORT}/api/ports"
```

### 方式二：Inbox 消息（SOTAgent 离线时）

写入 `~/.sotagent/inbox/<device_id>/port-request-<timestamp>.json`：

```json
{
  "type": "port_request",
  "from": "gsd2-agent",
  "device": "macbook-pro",
  "project": "my-project",
  "timestamp": "2026-04-15T12:00:00Z",
  "payload": {
    "service_name": "my-service",
    "preferred_port": 5500,
    "port_range_start": 3000,
    "port_range_end": 9995
  }
}
```

SOTAgent 下次启动时处理，结果写入 `~/.sotagent/outbox/<project>/`。

### 方式三：读取 ports.json（只读查询）

已分配的核心端口写在 `~/.sotagent/ports.json`，可直接读取：

```bash
cat ~/.sotagent/ports.json
# 包含 sotagent_api, sotagent_console, polar_private 等
# 以及 _governance 段描述 API 地址
```

## PolarCopilot 集成

`lib-isolate.sh` 已自动通过 SOTAgent API 申请 Hub 端口：
- SOTAgent 在线 → API 分配合规端口并注册到 port_registry
- SOTAgent 离线 → 退化为确定性 hash 取整到最近的 5 倍数（仍合规）

## 合规检查

端口号 `P` 合规当且仅当 `P % 10 == 0 || P % 10 == 5`。

违规示例：4801, 3001, 8791
合规示例：4800, 4805, 3000, 8790, 15550
