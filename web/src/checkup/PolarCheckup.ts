/**
 * <polar-checkup> — embeddable bug-report Web Component.
 *
 * Per 任务书/260508_compiled/PolarCopilot_web_checkup_widget.md, this is the
 * single shared widget across the ecosystem. Hosts embed it with:
 *
 *   <polar-checkup data-project="MyProject"></polar-checkup>
 *
 * The widget owns its Shadow DOM so host styles cannot leak in.
 */

import { SHADOW_CSS } from './styles.js';
import { captureViewport, cropBase64, type ClipRect } from './screenshot.js';
import { AnnotatorController, type Annotation, type AnnotationKind } from './annotator.js';
import { submitCheckup, type SubmitResult } from './submitter.js';
import { CHECKUP_AGENT_ID } from './constants.js';

const DEFAULT_HUB_URL = typeof window !== 'undefined' && window.location.origin !== 'null'
  ? window.location.origin
  : 'http://127.0.0.1:8040';

const TRIGGER_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="9"></circle>
  <path d="M12 8v4"></path>
  <circle cx="12" cy="16" r="0.6" fill="currentColor"></circle>
</svg>`;

type Position = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

const VALID_POSITIONS: ReadonlySet<Position> = new Set([
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
]);

const TOOLS: readonly { kind: AnnotationKind; label: string }[] = [
  { kind: 'rect', label: '矩形' },
  { kind: 'arrow', label: '箭头' },
  { kind: 'text', label: '文字' },
  { kind: 'freehand', label: '手绘' },
];

export class PolarCheckup extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['data-project', 'data-hub-url', 'data-position'];
  }

  private root: ShadowRoot;
  private trigger!: HTMLButtonElement;
  private overlay!: HTMLDivElement;
  private screenshotImg!: HTMLImageElement;
  private annotationCanvas!: HTMLCanvasElement;
  private toolButtons: Record<AnnotationKind, HTMLButtonElement> = {} as Record<
    AnnotationKind,
    HTMLButtonElement
  >;
  private textArea!: HTMLTextAreaElement;
  private statusEl!: HTMLDivElement;
  private submitBtn!: HTMLButtonElement;
  private historyLink!: HTMLAnchorElement;

  private annotator?: AnnotatorController;
  private screenshotB64?: string;
  private screenshotClip?: ClipRect;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    this.renderShadowDom();
  }

  connectedCallback(): void {
    this.applyPosition();
    this.applyHistoryLink();
  }

  attributeChangedCallback(name: string, _oldVal: string | null, _newVal: string | null): void {
    if (name === 'data-position') this.applyPosition();
    if (name === 'data-hub-url') this.applyHistoryLink();
  }

  private renderShadowDom(): void {
    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;

    const trigger = document.createElement('button');
    trigger.className = 'pc-trigger';
    trigger.setAttribute('aria-label', '提交 bug / 检修事件');
    trigger.dataset.position = 'bottom-right';
    trigger.innerHTML = TRIGGER_ICON_SVG;
    trigger.addEventListener('click', () => this.openPanel());
    this.trigger = trigger;

    const overlay = document.createElement('div');
    overlay.className = 'pc-overlay pc-hidden';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '检修事件提交');
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.closePanel();
    });

    const panel = document.createElement('div');
    panel.className = 'pc-panel';

    panel.appendChild(this.renderHeader());
    panel.appendChild(this.renderBody());
    panel.appendChild(this.renderFooter());

    overlay.appendChild(panel);
    this.overlay = overlay;

    this.root.append(style, trigger, overlay);
  }

  private renderHeader(): HTMLElement {
    const header = document.createElement('header');
    header.className = 'pc-header';
    const h2 = document.createElement('h2');
    h2.textContent = '提交检修事件';
    const close = document.createElement('button');
    close.className = 'pc-close';
    close.setAttribute('aria-label', '关闭');
    close.textContent = '×';
    close.addEventListener('click', () => this.closePanel());
    header.append(h2, close);
    return header;
  }

  private renderBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'pc-body';

    const screenshotLabel = document.createElement('label');
    screenshotLabel.textContent = '截图与批注';

    const wrap = document.createElement('div');
    wrap.className = 'pc-canvas-wrap';
    const img = document.createElement('img');
    img.alt = '页面截图（待截图）';
    this.screenshotImg = img;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    canvas.style.cursor = 'crosshair';
    canvas.style.touchAction = 'none';
    this.annotationCanvas = canvas;
    wrap.append(img, canvas);

    const tools = document.createElement('div');
    tools.className = 'pc-tools';
    const captureBtn = document.createElement('button');
    captureBtn.type = 'button';
    captureBtn.className = 'pc-tool';
    captureBtn.textContent = '📷 重新截图';
    captureBtn.addEventListener('click', () => void this.runCapture());
    tools.appendChild(captureBtn);

    for (const t of TOOLS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pc-tool';
      btn.textContent = t.label;
      btn.setAttribute('aria-pressed', 'false');
      btn.disabled = true;
      btn.addEventListener('click', () => this.selectTool(t.kind));
      this.toolButtons[t.kind] = btn;
      tools.appendChild(btn);
    }

    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'pc-tool';
    undoBtn.textContent = '↶ 撤销';
    undoBtn.addEventListener('click', () => {
      this.annotator?.undo();
      this.annotator?.redraw();
    });
    tools.appendChild(undoBtn);

    const textLabel = document.createElement('label');
    textLabel.textContent = '描述';
    const textArea = document.createElement('textarea');
    textArea.className = 'pc-textarea';
    textArea.placeholder = '请描述遇到的问题，越具体越好…';
    this.textArea = textArea;

    body.append(screenshotLabel, wrap, tools, textLabel, textArea);
    this.bindCanvasPointer();
    return body;
  }

  private renderFooter(): HTMLElement {
    const footer = document.createElement('footer');
    footer.className = 'pc-footer';

    const left = document.createElement('div');
    const status = document.createElement('div');
    status.className = 'pc-status';
    status.textContent = '准备就绪';
    this.statusEl = status;

    const history = document.createElement('a');
    history.className = 'pc-history';
    history.target = '_blank';
    history.rel = 'noopener noreferrer';
    history.textContent = '查看历史 →';
    this.historyLink = history;

    left.append(status);

    const actions = document.createElement('div');
    actions.className = 'pc-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pc-btn';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => this.closePanel());

    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'pc-btn pc-btn-primary';
    submit.textContent = '提交';
    submit.addEventListener('click', () => void this.runSubmit());
    this.submitBtn = submit;

    actions.append(history, cancel, submit);
    footer.append(left, actions);
    return footer;
  }

  private bindCanvasPointer(): void {
    const c = this.annotationCanvas;
    let dragging = false;

    const toCanvasCoords = (ev: PointerEvent) => {
      const rect = c.getBoundingClientRect();
      const scaleX = c.width / rect.width;
      const scaleY = c.height / rect.height;
      return { x: (ev.clientX - rect.left) * scaleX, y: (ev.clientY - rect.top) * scaleY };
    };

    c.addEventListener('pointerdown', (ev) => {
      if (!this.annotator) return;
      const tool = this.annotator.getTool();
      const p = toCanvasCoords(ev);
      if (tool === 'text') {
        const value = window.prompt('输入文字批注：');
        this.annotator.beginAt(p);
        this.annotator.end(value ?? '');
        return;
      }
      dragging = true;
      c.setPointerCapture(ev.pointerId);
      this.annotator.beginAt(p);
    });

    c.addEventListener('pointermove', (ev) => {
      if (!dragging || !this.annotator) return;
      this.annotator.moveTo(toCanvasCoords(ev));
    });

    const finish = (ev: PointerEvent) => {
      if (!dragging || !this.annotator) return;
      dragging = false;
      try {
        c.releasePointerCapture(ev.pointerId);
      } catch {
        /* not captured */
      }
      this.annotator.end();
    };
    c.addEventListener('pointerup', finish);
    c.addEventListener('pointercancel', finish);
  }

  private selectTool(kind: AnnotationKind): void {
    if (!this.annotator) return;
    this.annotator.setTool(kind);
    for (const k of Object.keys(this.toolButtons) as AnnotationKind[]) {
      this.toolButtons[k].setAttribute('aria-pressed', k === kind ? 'true' : 'false');
    }
  }

  private applyPosition(): void {
    const raw = (this.dataset.position ?? 'bottom-right').toLowerCase();
    const pos: Position = (VALID_POSITIONS.has(raw as Position) ? raw : 'bottom-right') as Position;
    this.trigger.dataset.position = pos;
  }

  private applyHistoryLink(): void {
    const hub = this.dataset.hubUrl ?? DEFAULT_HUB_URL;
    this.historyLink.href = `${hub.replace(/\/$/, '')}/ui/checkup-events`;
  }

  private openPanel(): void {
    this.overlay.classList.remove('pc-hidden');
    void this.runCapture();
  }

  private closePanel(): void {
    this.overlay.classList.add('pc-hidden');
    this.resetForm();
  }

  private resetForm(): void {
    this.textArea.value = '';
    this.screenshotB64 = undefined;
    this.screenshotClip = undefined;
    this.annotator?.reset();
    if (this.annotator) this.annotator.redraw();
    this.setStatus('准备就绪', 'info');
  }

  private async runCapture(): Promise<void> {
    this.setStatus('正在截图…', 'info');
    try {
      const result = await captureViewport({ ignoreElement: this });
      this.screenshotB64 = result.pngBase64;
      this.screenshotImg.src = `data:image/png;base64,${result.pngBase64}`;
      const wait = () =>
        new Promise<void>((resolve) => {
          if (this.screenshotImg.complete) resolve();
          else this.screenshotImg.onload = () => resolve();
        });
      await wait();
      this.annotationCanvas.width = result.width;
      this.annotationCanvas.height = result.height;
      this.annotator = new AnnotatorController(this.annotationCanvas, () =>
        this.annotator?.redraw(),
      );
      for (const k of Object.keys(this.toolButtons) as AnnotationKind[])
        this.toolButtons[k].disabled = false;
      this.selectTool('rect');
      this.setStatus(
        `截图完成 (${result.width}×${result.height}, scale ${result.scale.toFixed(2)})`,
        'success',
      );
    } catch (err) {
      this.setStatus(`截图失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  private async runSubmit(): Promise<void> {
    const project = this.dataset.project ?? '';
    const hubUrl = this.dataset.hubUrl ?? DEFAULT_HUB_URL;
    const userText = this.textArea.value.trim();

    if (!project) return this.setStatus('缺少 data-project', 'error');
    if (!userText) return this.setStatus('请填写问题描述', 'error');

    this.submitBtn.disabled = true;
    this.setStatus('提交中…', 'info');

    let annotations: Annotation[] | undefined;
    if (this.annotator) {
      const list = this.annotator.serialize();
      if (list.length > 0) annotations = list;
    }

    let cropped: { pngBase64: string; clip?: ClipRect } | undefined;
    if (this.screenshotB64 && this.screenshotClip) {
      try {
        const cr = await cropBase64(this.screenshotB64, this.screenshotClip);
        cropped = { pngBase64: cr.pngBase64, clip: this.screenshotClip };
      } catch {
        cropped = { pngBase64: this.screenshotB64 };
      }
    } else if (this.screenshotB64) {
      cropped = { pngBase64: this.screenshotB64 };
    }

    let res: SubmitResult;
    try {
      res = await submitCheckup({
        hubUrl,
        project,
        agentTarget: CHECKUP_AGENT_ID,
        pageUrl: window.location.href,
        pageTitle: document.title,
        userText,
        screenshotB64: cropped?.pngBase64,
        screenshotClip: cropped?.clip,
        annotations,
        userSession: {
          browser: navigator.userAgent,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        },
      });
    } catch (err) {
      this.submitBtn.disabled = false;
      this.setStatus(`网络错误：${err instanceof Error ? err.message : String(err)}`, 'error');
      return;
    }

    this.submitBtn.disabled = false;
    if (res.ok) {
      const fwd =
        res.forwardedToSotagent === undefined
          ? ''
          : res.forwardedToSotagent
            ? '（已聚合）'
            : '（聚合服务暂不可达，事件已 Hub 入队）';
      this.setStatus(`已提交 ✓ event_id=${res.eventId} ${fwd}`, 'success');
      window.setTimeout(() => this.closePanel(), 1500);
    } else {
      this.setStatus(`提交失败 (HTTP ${res.status})：${JSON.stringify(res.error)}`, 'error');
    }
  }

  private setStatus(text: string, kind: 'info' | 'success' | 'error'): void {
    this.statusEl.textContent = text;
    if (kind === 'info') this.statusEl.removeAttribute('data-kind');
    else this.statusEl.setAttribute('data-kind', kind);
  }
}

let registered = false;

/** Idempotent custom element registration. */
export function registerPolarCheckup(): void {
  if (registered) return;
  if (typeof window === 'undefined' || !window.customElements) return;
  if (!window.customElements.get('polar-checkup')) {
    window.customElements.define('polar-checkup', PolarCheckup);
  }
  registered = true;
}
