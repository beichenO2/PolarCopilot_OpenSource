# Hub Web UI 架构备忘

> ⚠️ 本文件记录 Hub Web UI 的关键实现决策，**防止被意外 revert**。

## 关键组件

### PromptCard (`web/src/components/PromptCard.tsx`)

**批注系统（Annotation）**：
- 使用 DOM Range API 将批注直接注入渲染后的 markdown 内容
- `<mark>` 标签高亮选中文字 + `<span>` 标签内联显示批注内容
- 跨节点选中（如跨表格行）时 fallback 到块级元素插入在结构下方
- 点击选项按钮时自动携带所有批注（`annotations.map` 拼接到 answer）
- **不要改回 React state 渲染方式** — 因为 `dangerouslySetInnerHTML` 不与 React 状态同步

**Textarea 自动增高**：
- `autoResize()`: 临时切 `overflow:hidden` → 读 `scrollHeight` → 恢复 `overflow`
- 批注 textarea 也有独立的 auto-resize（`annTextareaRef`）
- **不要加 `resize-y`** — 会与 auto-resize 冲突

### PromptsPage (`web/src/pages/PromptsPage.tsx`)

**排序**：
- `filteredPrompts` 和 `filteredHistory` 都按 `created_at` 倒序（最新在前）
- **不要去掉 sort** — 用户依赖这个顺序

**滚动记忆**：
- `filterScrollPositions` (module-level Map) 在切换筛选器时保存/恢复 `window.scrollY`
- **不要改成 state** — 需要跨 re-render 持久化

**输入持久化**：
- `draftInputs` / `draftHeights` (module-level Map) 保存每个 prompt 的输入草稿和高度
- **不要改成 state** — 同上

## 服务端关键配置

### ETag 禁用 (`hub/src/transport/http.ts`)

```
app.set('etag', false)                    // 全局禁用 ETag
/api/ui middleware: removeHeader('ETag')   // 防 API 304
express.static: { etag: false }           // 防静态文件 304
SPA fallback: Cache-Control: no-store     // 防 index.html 304
```

**不要恢复 ETag** — 浏览器 3s 轮询 + ETag = 304 = UI 不更新 = 用户看不到新 pending

## 构建流程

修改 `web/src/` 后必须 `cd web && npm run build` 才能在 Hub UI 生效。
Hub 通过 `express.static(~/Polarisor/PolarCopilot/web/dist)` 提供静态文件。
