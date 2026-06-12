<no_delete_policy>

# 禁止删除策略（所有 Agent 强制执行）

## 核心规则

**⛔ 绝对禁止使用 `rm`、`rmdir`、`unlink`、`shutil.rmtree` 等任何删除命令。**

所有"删除"操作必须替换为 `mv` 到统一垃圾箱目录。

---

## 垃圾箱路径

```
~/Desktop/ClawBin/
```

自动创建子目录按日期分组：
```
~/Desktop/ClawBin/2026-04-12/
~/Desktop/ClawBin/2026-04-12/original-path-encoded/
```

---

## 替代命令

### Shell 环境

```bash
# ❌ 禁止
rm -rf some-dir/
rm file.txt

# ✅ 正确做法（$HOME 自动适配任意设备）
CLAWBIN="$HOME/Desktop/ClawBin/$(date +%Y-%m-%d)"
mkdir -p "$CLAWBIN"
mv some-dir/ "$CLAWBIN/"
mv file.txt "$CLAWBIN/"
```

### Node.js 环境

```javascript
// ❌ 禁止
import { rmSync, unlinkSync } from 'node:fs';

// ✅ 正确做法
import { mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
const bin = `${homedir()}/Desktop/ClawBin/${new Date().toISOString().slice(0, 10)}`;
mkdirSync(bin, { recursive: true });
renameSync(path, `${bin}/${basename(path)}`);
```

### Python 环境

```python
# ❌ 禁止
import shutil, os

# ✅ 正确做法
from pathlib import Path
from datetime import date
claw_bin = Path.home() / "Desktop" / "ClawBin" / str(date.today())
claw_bin.mkdir(parents=True, exist_ok=True)
Path(path).rename(claw_bin / Path(path).name)
```

---

## 例外

以下场景允许真正删除（但必须在代码注释中说明原因）：

1. `node_modules/` 重装（`rm -rf node_modules && npm install`）
2. 构建产物清理（`dist/`, `build/`, `.cache/`）
3. 临时文件清理（`/tmp/` 下的文件）
4. Git 冲突锁文件（`.git/index.lock`）

除此之外，任何删除操作都必须走 ClawBin。

---

## 适用范围

- PolarCopilot 所有模式（solo, proxy, multi-agent, YOLO）
- PolarClaw 所有工具调用
- SOTAgent 所有脚本
- 任何由 Agent 触发的 shell 命令

---

## 垃圾箱清理

ClawBin 由用户手动清理，Agent 不得自动清理。
超过 30 天的文件可以在用户授权后真正删除。

</no_delete_policy>
