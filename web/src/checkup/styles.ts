/**
 * Shadow DOM scoped styles for <polar-checkup>.
 * No external CSS imports — every selector lives inside the widget's shadow root,
 * so host page styles cannot leak in and our styles cannot leak out.
 */

export const SHADOW_CSS = /* css */ `
  :host {
    all: initial;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    color: #1a1a1a;
  }

  .pc-trigger {
    position: fixed;
    z-index: 2147483646;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: #0f1d3a;
    color: #fff;
    border: none;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.15s ease;
  }
  .pc-trigger:hover { transform: scale(1.06); }
  .pc-trigger:active { transform: scale(0.95); }
  .pc-trigger svg { width: 22px; height: 22px; }

  .pc-trigger[data-position="bottom-right"] { right: 24px; bottom: 24px; }
  .pc-trigger[data-position="bottom-left"]  { left: 24px;  bottom: 24px; }
  .pc-trigger[data-position="top-right"]    { right: 24px; top: 24px; }
  .pc-trigger[data-position="top-left"]     { left: 24px;  top: 24px; }

  .pc-overlay {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .pc-panel {
    background: #fff;
    border-radius: 12px;
    width: min(720px, 92vw);
    max-height: 86vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
  }

  .pc-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    background: #0f1d3a;
    color: #fff;
  }
  .pc-header h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .pc-close {
    background: transparent;
    border: none;
    color: #fff;
    cursor: pointer;
    font-size: 22px;
    line-height: 1;
    padding: 4px 8px;
    border-radius: 4px;
  }
  .pc-close:hover { background: rgba(255, 255, 255, 0.12); }

  .pc-body { flex: 1; overflow: auto; padding: 16px 18px; display: grid; gap: 14px; }
  .pc-body label { font-weight: 600; font-size: 13px; color: #2a3a5a; }

  .pc-canvas-wrap {
    position: relative;
    border: 1px solid #d6dbe6;
    border-radius: 6px;
    background: #f6f7fa;
    min-height: 200px;
    overflow: hidden;
  }
  .pc-canvas-wrap img { display: block; width: 100%; height: auto; }
  .pc-canvas-wrap canvas { position: absolute; inset: 0; width: 100%; height: 100%; }

  .pc-tools {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    padding: 6px 0;
  }
  .pc-tool {
    border: 1px solid #d6dbe6;
    background: #fff;
    color: #2a3a5a;
    padding: 5px 10px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
  }
  .pc-tool[aria-pressed="true"] { background: #0f1d3a; color: #fff; border-color: #0f1d3a; }
  .pc-tool:disabled { opacity: 0.4; cursor: not-allowed; }

  .pc-textarea {
    width: 100%;
    min-height: 80px;
    border: 1px solid #d6dbe6;
    border-radius: 6px;
    padding: 8px 10px;
    font: inherit;
    color: inherit;
    resize: vertical;
    box-sizing: border-box;
  }
  .pc-textarea:focus { outline: 2px solid #4f7cff; outline-offset: 0; border-color: #4f7cff; }

  .pc-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 12px 18px;
    background: #f6f7fa;
    border-top: 1px solid #e3e7ef;
  }

  .pc-history {
    color: #4f7cff;
    text-decoration: none;
    font-size: 13px;
  }
  .pc-history:hover { text-decoration: underline; }

  .pc-actions { display: flex; gap: 8px; }
  .pc-btn {
    border: 1px solid #d6dbe6;
    background: #fff;
    color: #2a3a5a;
    padding: 7px 14px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
  }
  .pc-btn:hover { background: #f0f3fa; }
  .pc-btn-primary {
    background: #0f1d3a;
    border-color: #0f1d3a;
    color: #fff;
  }
  .pc-btn-primary:hover { background: #1a2c54; }
  .pc-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .pc-status { font-size: 12px; color: #6b7280; min-height: 16px; }
  .pc-status[data-kind="error"] { color: #b91c1c; }
  .pc-status[data-kind="success"] { color: #047857; }

  .pc-hidden { display: none !important; }
`;
