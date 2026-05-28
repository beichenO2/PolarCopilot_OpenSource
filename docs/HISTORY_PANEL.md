# History panel — resizable width

Both **Agent Control** and **YOLO** keep a **History** column on the right. Width is user-adjustable (not fixed pixels).

## Controls

| Action | Effect |
|--------|--------|
| Drag the vertical divider | Change share between main content and History |
| Double-click divider | Reset to default ratio; clears saved preference |
| ◀ / ▶ | Collapse or expand the History column |
| Hide / Show | Collapse only the list inside History (width unchanged) |

On viewports under 900px wide, History auto-collapses; widening the window restores it.

## Defaults and limits

| Page | `localStorage` key | Default (main area) | History min width |
|------|-------------------|---------------------|-------------------|
| Agent Control | `pc-prompts-history-ratio` | 72% | 200px |
| YOLO | `pc-yolo-history-ratio` | 68% | 220px |

Implementation: `web/src/components/ResizableSplitPane.tsx` (ratio = left panel width; History is the right panel).

## Reset in browser console

```javascript
localStorage.removeItem('pc-prompts-history-ratio')
localStorage.removeItem('pc-yolo-history-ratio')
location.reload()
```
