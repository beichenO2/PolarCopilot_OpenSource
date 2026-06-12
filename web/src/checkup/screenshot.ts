/**
 * Screenshot capture + crop helpers for <polar-checkup>.
 *
 * Wraps html2canvas so callers stay decoupled from the library, and enforces
 * the Agent_core checkup-event schema constraint of `screenshot_b64 <= 5MB` by
 * progressively scaling down the captured image until it fits.
 */

import html2canvas from 'html2canvas';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB per checkup-event.schema.json

export interface CaptureOptions {
  /** Element to ignore during capture (typically the widget host itself). */
  ignoreElement?: HTMLElement;
  /** Initial scale; capture is retried at lower scale if base64 exceeds 5MB. */
  initialScale?: number;
}

export interface CaptureResult {
  /** PNG base64 (no data: prefix). */
  pngBase64: string;
  /** Final scale factor used. */
  scale: number;
  width: number;
  height: number;
}

export async function captureViewport(opts: CaptureOptions = {}): Promise<CaptureResult> {
  const ignore = opts.ignoreElement;
  let scale = opts.initialScale ?? Math.min(window.devicePixelRatio ?? 1, 2);

  for (let attempt = 0; attempt < 4; attempt++) {
    const canvas = await html2canvas(document.body, {
      scale,
      useCORS: true,
      logging: false,
      ignoreElements: (el) => (ignore ? el === ignore || ignore.contains(el) : false),
    });
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const bytes = Math.ceil((base64.length * 3) / 4);
    if (bytes <= MAX_BYTES) {
      return { pngBase64: base64, scale, width: canvas.width, height: canvas.height };
    }
    scale = scale * 0.7;
  }

  // Last resort: return the smallest attempt regardless of size.
  const canvas = await html2canvas(document.body, { scale, useCORS: true, logging: false });
  return {
    pngBase64: canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''),
    scale,
    width: canvas.width,
    height: canvas.height,
  };
}

export interface ClipRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Crop a base64 PNG using the given pixel rect; returns a new base64 PNG. */
export async function cropBase64(
  base64: string,
  clip: ClipRect,
): Promise<{ pngBase64: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(clip.width));
      canvas.height = Math.max(1, Math.round(clip.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('canvas 2d context unavailable'));
        return;
      }
      ctx.drawImage(img, clip.x, clip.y, clip.width, clip.height, 0, 0, canvas.width, canvas.height);
      const out = canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
      resolve({ pngBase64: out, width: canvas.width, height: canvas.height });
    };
    img.onerror = () => reject(new Error('failed to decode base64 PNG'));
    img.src = `data:image/png;base64,${base64}`;
  });
}
