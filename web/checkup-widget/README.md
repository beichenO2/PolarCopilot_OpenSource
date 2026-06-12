# @polarcop/checkup-widget

Embeddable `<polar-checkup>` Web Component. One-click bug-report widget that
ships across every Polarisor frontend. Routes events through PolarCopilot Hub
to the dedicated **`@checkup-agent`** inbox (not project owner sessions), and
aggregates them on SOTAgent.

## Install

### As a bundled module

```bash
npm install @polarcop/checkup-widget
```

```ts
import '@polarcop/checkup-widget';

// ...somewhere in your layout
// <polar-checkup data-project="KnowLever"></polar-checkup>
```

### Via plain `<script>` (no build step)

```html
<script type="module" src="https://your-cdn/checkup-widget/dist/checkup-widget.es.js"></script>
<polar-checkup data-project="KnowLever"></polar-checkup>
```

## Attributes

| Attribute | Required | Default | Notes |
|-----------|----------|---------|-------|
| `data-project` | yes | — | Project name in `event.project` (where the bug occurred). |
| `data-agent` | no | *(ignored)* | **Deprecated.** Widget always routes to `@checkup-agent`. |
| `data-hub-url` | no | current origin or `http://127.0.0.1:8040` | PolarCopilot Hub origin. |
| `data-position` | no | `bottom-right` | One of `bottom-right \| bottom-left \| top-right \| top-left`. |

## Event payload

The widget submits a payload that conforms to
[`Agent_core/contracts/checkup-event.schema.json`](../../../Agent_core/contracts/checkup-event.schema.json):

```json
{
  "event_id": "<uuid v4>",
  "project": "KnowLever",
  "agent_target": "@checkup-agent",
  "page_url": "https://app.example/dashboard",
  "page_title": "Dashboard",
  "user_text": "Sidebar overlaps the chart at >1440 px",
  "screenshot_b64": "<png base64, ≤ 5 MB>",
  "annotations": [
    { "kind": "rect", "geometry": { "x": 12, "y": 34, "width": 80, "height": 40 } },
    { "kind": "text", "geometry": { "x": 100, "y": 50 }, "text": "broken here" }
  ],
  "user_session": { "browser": "Mozilla/5.0…", "viewport": { "width": 1440, "height": 900 } },
  "timestamp": "2026-05-08T13:42:00.000Z"
}
```

## Behaviour

- **Submit side**: in-place. Click the floating button, the widget captures the
  current viewport, lets the user crop / draw on the screenshot, then POSTs the
  payload to `${data-hub-url}/api/checkup-event`.
- **History side**: jump-out. The "查看历史 →" link opens
  `${data-hub-url}/ui/checkup-events` so users see the centralised history page
  served by Hub Web from SOTAgent's `data/checkup-events.jsonl`.

## Privacy

Sensitive form values (passwords, tokens) are visible in the screenshot. The
widget does not auto-mask anything. Hosts that handle PII must instruct end
users to redact via the rect tool before submitting, or implement DOM-level
masking before invoking the widget.

## Ecosystem sync (P0/P1 batch embed)

```bash
cd PolarCopilot/web && npm run build:widget
node ../../../Agent_core/scripts/sync-checkup-widget.mjs
```

Copies `checkup-widget.es.js` to PolarUI, Clock, SOTAgent, KnowLever, PolarDesign, tqsdk, PolarClaw, and Hub static.

**API-only projects** (no local HTML): Hub landing pages (restart Hub after sync):

| URL | `data-project` |
|-----|----------------|
| `http://127.0.0.1:8040/embed/PolarPort` | PolarPort |
| `http://127.0.0.1:8040/embed/PolarMemory` | PolarMemory |
| `http://127.0.0.1:8040/embed/PolarProcess` | PolarProcess |
| `http://127.0.0.1:8040/embed/PolarPilot` | PolarPilot |
| `http://127.0.0.1:8040/embed/digist` | digist |
| `http://127.0.0.1:8040/embed/AutoOffice` | AutoOffice |

## Build

```bash
npm install
npm run build:widget   # outputs checkup-widget/dist/{checkup-widget.es.js,checkup-widget.umd.js}
npm test               # vitest suite (jsdom)
```
