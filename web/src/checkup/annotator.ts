/**
 * Annotation model for <polar-checkup>.
 *
 * Each annotation matches the `kind` enum in
 * Agent_core/contracts/checkup-event.schema.json:
 *   "arrow" | "rect" | "text" | "freehand"
 *
 * Geometry is intentionally schema-shape (not graphics-shape) so it survives
 * JSON round-trips without our own decoder. The submitter copies it verbatim.
 */

export type AnnotationKind = 'arrow' | 'rect' | 'text' | 'freehand';

export interface Point {
  x: number;
  y: number;
}

/** Schema-compatible annotation envelope. */
export interface Annotation {
  kind: AnnotationKind;
  geometry: Record<string, unknown>;
  text?: string;
}

export interface ArrowAnnotation extends Annotation {
  kind: 'arrow';
  geometry: { from: Point; to: Point };
}

export interface RectAnnotation extends Annotation {
  kind: 'rect';
  geometry: { x: number; y: number; width: number; height: number };
}

export interface TextAnnotation extends Annotation {
  kind: 'text';
  geometry: { x: number; y: number };
  text: string;
}

export interface FreehandAnnotation extends Annotation {
  kind: 'freehand';
  geometry: { points: Point[] };
}

/**
 * Renders the live in-progress annotation plus all committed annotations.
 * Returns the public API used by `PolarCheckup`'s pointer handlers.
 */
export class AnnotatorController {
  private committed: Annotation[] = [];
  private inFlight: Annotation | null = null;
  private currentTool: AnnotationKind = 'rect';

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onChange: () => void,
  ) {}

  setTool(tool: AnnotationKind): void {
    this.currentTool = tool;
    this.inFlight = null;
    this.onChange();
  }

  getTool(): AnnotationKind {
    return this.currentTool;
  }

  beginAt(point: Point): void {
    if (this.currentTool === 'arrow') {
      this.inFlight = { kind: 'arrow', geometry: { from: point, to: point } } as ArrowAnnotation;
    } else if (this.currentTool === 'rect') {
      this.inFlight = {
        kind: 'rect',
        geometry: { x: point.x, y: point.y, width: 0, height: 0 },
      } as RectAnnotation;
    } else if (this.currentTool === 'freehand') {
      this.inFlight = { kind: 'freehand', geometry: { points: [point] } } as FreehandAnnotation;
    } else if (this.currentTool === 'text') {
      this.inFlight = { kind: 'text', geometry: point, text: '' } as TextAnnotation;
    }
    this.onChange();
  }

  moveTo(point: Point): void {
    if (!this.inFlight) return;
    if (this.inFlight.kind === 'arrow') {
      (this.inFlight.geometry as { from: Point; to: Point }).to = point;
    } else if (this.inFlight.kind === 'rect') {
      const g = this.inFlight.geometry as { x: number; y: number; width: number; height: number };
      g.width = point.x - g.x;
      g.height = point.y - g.y;
    } else if (this.inFlight.kind === 'freehand') {
      const g = this.inFlight.geometry as { points: Point[] };
      g.points.push(point);
    }
    this.onChange();
  }

  end(textValue?: string): void {
    if (!this.inFlight) return;
    if (this.inFlight.kind === 'rect') {
      const g = this.inFlight.geometry as { x: number; y: number; width: number; height: number };
      if (g.width < 0) {
        g.x += g.width;
        g.width = -g.width;
      }
      if (g.height < 0) {
        g.y += g.height;
        g.height = -g.height;
      }
      if (g.width < 4 && g.height < 4) {
        this.inFlight = null;
        this.onChange();
        return;
      }
    }
    if (this.inFlight.kind === 'text') {
      const trimmed = (textValue ?? '').trim();
      if (!trimmed) {
        this.inFlight = null;
        this.onChange();
        return;
      }
      this.inFlight.text = trimmed;
    }
    this.committed.push(this.inFlight);
    this.inFlight = null;
    this.onChange();
  }

  cancelInFlight(): void {
    this.inFlight = null;
    this.onChange();
  }

  undo(): void {
    this.committed.pop();
    this.onChange();
  }

  reset(): void {
    this.committed = [];
    this.inFlight = null;
    this.onChange();
  }

  /** Schema-compatible array (committed only — drops in-flight). */
  serialize(): Annotation[] {
    return this.committed.map((a) => ({ ...a, geometry: { ...a.geometry } }));
  }

  /** Repaints the canvas using committed + in-flight annotations. */
  redraw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const a of this.committed) drawAnnotation(ctx, a);
    if (this.inFlight) drawAnnotation(ctx, this.inFlight, true);
  }
}

function drawAnnotation(ctx: CanvasRenderingContext2D, a: Annotation, isInFlight = false): void {
  ctx.save();
  ctx.strokeStyle = isInFlight ? '#ff7a00' : '#e0245e';
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (a.kind === 'arrow') {
    const { from, to } = a.geometry as { from: Point; to: Point };
    drawArrow(ctx, from, to);
  } else if (a.kind === 'rect') {
    const { x, y, width, height } = a.geometry as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    ctx.strokeRect(x, y, width, height);
  } else if (a.kind === 'text') {
    const g = a.geometry as unknown as Point;
    ctx.font = 'bold 16px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(a.text ?? '', g.x, g.y);
  } else if (a.kind === 'freehand') {
    const { points } = a.geometry as { points: Point[] };
    const first = points[0];
    if (first) {
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < points.length; i++) {
        const p = points[i];
        if (p) ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
  }

  ctx.restore();
}

function drawArrow(ctx: CanvasRenderingContext2D, from: Point, to: Point): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  const headLen = Math.min(14, len * 0.25);
  const angle = Math.atan2(dy, dx);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - headLen * Math.cos(angle - Math.PI / 7), to.y - headLen * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(to.x - headLen * Math.cos(angle + Math.PI / 7), to.y - headLen * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}
