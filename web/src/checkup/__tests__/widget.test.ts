/**
 * Vitest suite for <polar-checkup>.
 *
 * Covers:
 *   - Web Component registration + Shadow DOM construction
 *   - data-* attribute reactivity
 *   - AnnotatorController serialization (4 kinds + undo)
 *   - submitCheckup payload shape + happy path / 4xx / network error
 *
 * Real DOM via jsdom; html2canvas is NOT exercised here (graphics-heavy and
 * jsdom can't paint reliably). The screenshot module is unit-tested via crop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnnotatorController } from '../annotator.js';
import { submitCheckup } from '../submitter.js';
import { registerPolarCheckup, PolarCheckup } from '../PolarCheckup.js';

beforeEach(() => {
  registerPolarCheckup();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('<polar-checkup> Web Component', () => {
  it('registers as a custom element', () => {
    expect(window.customElements.get('polar-checkup')).toBe(PolarCheckup);
  });

  it('creates an open Shadow DOM with a trigger button', () => {
    const el = document.createElement('polar-checkup') as PolarCheckup;
    el.dataset.project = 'KnowLever';
    document.body.appendChild(el);
    const root = el.shadowRoot;
    expect(root).toBeTruthy();
    const trigger = root!.querySelector('.pc-trigger');
    expect(trigger).toBeTruthy();
    expect(trigger?.getAttribute('aria-label')).toContain('提交');
  });

  it('reflects data-position on the trigger', () => {
    const el = document.createElement('polar-checkup') as PolarCheckup;
    el.dataset.project = 'X';
    el.dataset.position = 'top-left';
    document.body.appendChild(el);
    const trigger = el.shadowRoot!.querySelector<HTMLElement>('.pc-trigger')!;
    expect(trigger.dataset.position).toBe('top-left');
    el.dataset.position = 'invalid-value';
    expect(trigger.dataset.position).toBe('bottom-right');
  });

  it('builds the history link from data-hub-url', () => {
    const el = document.createElement('polar-checkup') as PolarCheckup;
    el.dataset.project = 'X';
    el.dataset.hubUrl = 'http://example.test:9000';
    document.body.appendChild(el);
    const link = el.shadowRoot!.querySelector<HTMLAnchorElement>('.pc-history')!;
    expect(link.href).toBe('http://example.test:9000/ui/checkup-events');
  });
});

describe('AnnotatorController', () => {
  function makeCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 200;
    return c;
  }

  it('records a rect annotation across a drag', () => {
    const onChange = vi.fn();
    const a = new AnnotatorController(makeCanvas(), onChange);
    a.setTool('rect');
    a.beginAt({ x: 10, y: 20 });
    a.moveTo({ x: 80, y: 60 });
    a.end();
    expect(a.serialize()).toEqual([
      { kind: 'rect', geometry: { x: 10, y: 20, width: 70, height: 40 } },
    ]);
  });

  it('records an arrow annotation with from/to', () => {
    const a = new AnnotatorController(makeCanvas(), vi.fn());
    a.setTool('arrow');
    a.beginAt({ x: 5, y: 5 });
    a.moveTo({ x: 50, y: 50 });
    a.end();
    const arr = a.serialize();
    expect(arr).toHaveLength(1);
    expect(arr[0].kind).toBe('arrow');
    expect(arr[0].geometry).toEqual({ from: { x: 5, y: 5 }, to: { x: 50, y: 50 } });
  });

  it('records a freehand annotation as a points array', () => {
    const a = new AnnotatorController(makeCanvas(), vi.fn());
    a.setTool('freehand');
    a.beginAt({ x: 0, y: 0 });
    a.moveTo({ x: 10, y: 10 });
    a.moveTo({ x: 20, y: 20 });
    a.end();
    const arr = a.serialize();
    expect(arr).toHaveLength(1);
    expect(arr[0].kind).toBe('freehand');
    expect((arr[0].geometry as { points: { x: number; y: number }[] }).points).toHaveLength(3);
  });

  it('drops empty text annotations and undo()s the last committed', () => {
    const a = new AnnotatorController(makeCanvas(), vi.fn());
    a.setTool('text');
    a.beginAt({ x: 100, y: 100 });
    a.end('   '); // whitespace-only → drop
    expect(a.serialize()).toHaveLength(0);

    a.beginAt({ x: 100, y: 100 });
    a.end('Hello');
    a.beginAt({ x: 110, y: 110 });
    a.end('World');
    expect(a.serialize()).toHaveLength(2);

    a.undo();
    expect(a.serialize()).toHaveLength(1);
    expect(a.serialize()[0].text).toBe('Hello');
  });

  it('drops zero-area rects', () => {
    const a = new AnnotatorController(makeCanvas(), vi.fn());
    a.setTool('rect');
    a.beginAt({ x: 50, y: 50 });
    a.moveTo({ x: 51, y: 51 });
    a.end();
    expect(a.serialize()).toHaveLength(0);
  });
});

describe('submitCheckup', () => {
  const baseCtx = {
    hubUrl: 'http://hub.test',
    project: 'KnowLever',
    pageUrl: 'http://app.test/page',
    userText: 'something is broken',
    uuidImpl: () => '00000000-0000-4000-8000-000000000001',
  };

  it('builds a schema-shaped payload and POSTs to /api/checkup-event', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, event_id: 'srv-id', forwarded_to_sotagent: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const res = await submitCheckup({ ...baseCtx, fetchImpl });
    expect(res.ok).toBe(true);
    expect(res.eventId).toBe('srv-id');
    expect(res.forwardedToSotagent).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://hub.test/api/checkup-event');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.event_id).toBe('00000000-0000-4000-8000-000000000001');
    expect(body.project).toBe('KnowLever');
    expect(body.agent_target).toBe('@checkup-agent');
    expect(body.page_url).toBe('http://app.test/page');
    expect(body.user_text).toBe('something is broken');
    expect(typeof body.timestamp).toBe('string');
  });

  it('omits optional fields when not provided', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, event_id: 'x' }), { status: 200 }),
    );
    await submitCheckup({ ...baseCtx, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body.screenshot_b64).toBeUndefined();
    expect(body.annotations).toBeUndefined();
    expect(body.user_session).toBeUndefined();
  });

  it('returns ok=false on non-2xx responses', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: 'invalid_payload' }), { status: 400 }),
    );
    const res = await submitCheckup({ ...baseCtx, fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error).toEqual({ ok: false, error: 'invalid_payload' });
  });

  it('throws when required context fields are missing', async () => {
    await expect(submitCheckup({ ...baseCtx, project: '' })).rejects.toThrow(/project/);
    await expect(submitCheckup({ ...baseCtx, pageUrl: '' })).rejects.toThrow(/pageUrl/);
    await expect(submitCheckup({ ...baseCtx, userText: '' })).rejects.toThrow(/userText/);
  });
});
