export const styles = `
  :host { display:block }
  :host([hidden]) { display:none }
  .editor {
    color-scheme: light dark;
    box-sizing:border-box; background:Canvas; color:CanvasText;
    max-width:100%; border:1px solid color-mix(in srgb, CanvasText 20%, Canvas);
    border-radius:12px; padding:clamp(16px,4vw,32px);
    font:16px/1.5 "Inter", system-ui, sans-serif;
  }
  [data-theme=light] { color-scheme:light }
  [data-theme=dark] { color-scheme:dark }
  header { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px }
  h2,h3,p { margin:0 }
  h2 { font-size:1.4rem; overflow-wrap:anywhere }
  h3 { margin-top:2rem; font-size:1rem }
  p { margin:.5rem 0; font-size:.9rem }
  button { font:inherit; padding:.45rem 1rem; background:#24563f; color:white; border:0; border-radius:6px; cursor:pointer }
  button:disabled { opacity:.6; cursor:default }
  pre { overflow:auto; padding:1rem; margin:0; background:color-mix(in srgb, CanvasText 6%, Canvas); border-radius:6px }
  pre:empty { display:none }
  .canvas-panel { margin-top:1.25rem; position:relative; border:1px solid color-mix(in srgb, CanvasText 16%, Canvas); border-radius:8px; overflow:clip }
  .canvas { height:clamp(260px,38vh,460px); position:relative; overflow:clip; isolation:isolate;
    background-color:color-mix(in srgb, CanvasText 2%, Canvas);
    background-image:radial-gradient(color-mix(in srgb, CanvasText 16%, Canvas) 1px,transparent 1px);
    background-size:16px 16px; touch-action:none; user-select:none }
  .canvas:focus-visible { outline:2px solid Highlight; outline-offset:-2px }
  .canvas.panning, .canvas.panning * { cursor:grabbing }
  .world { position:absolute; top:0; left:0; transform-origin:0 0; will-change:transform }
  .world svg { position:absolute; top:0; left:0; overflow:visible; pointer-events:none }
  .world path { fill:none; stroke:color-mix(in srgb, CanvasText 49%, Canvas); stroke-width:2 }
  .node-card { position:absolute; box-sizing:border-box; width:180px; height:72px; display:grid;
    align-content:center; justify-items:start; gap:1px; padding:5px 14px; text-align:start;
    border:1px solid color-mix(in srgb, CanvasText 34%, Canvas); border-radius:9px; background:Canvas;
    color:CanvasText; box-shadow:0 2px 5px #0001; font:inherit }
  .node-card strong,.node-card small,.node-state { display:block; max-width:100%; overflow:hidden; white-space:nowrap; text-overflow:ellipsis }
  .node-card small,.node-state { font-size:11px; line-height:1.35 }
  .node-state { color:color-mix(in srgb, CanvasText 80%, Canvas) }
  .node-card[data-state=success] { border-color:#358360 }
  .node-card[data-state=error] { border-color:#c45942 }
  .node-card[aria-pressed=true] { outline:3px solid #518fe4; outline-offset:2px }
  .node-card:focus-visible { box-shadow:inset 0 0 0 2px Highlight }
  .port { position:absolute; width:7px; height:7px; transform:translate(-50%,-50%); border:1px solid CanvasText; background:Canvas; border-radius:50% }
  .port.input { left:0 } .port.output { left:100% }
  .marquee { position:absolute; box-sizing:border-box; border:1px solid #518fe4; background:#518fe425; pointer-events:none }
  .view-controls { display:flex; align-items:center; justify-content:flex-end; gap:4px; padding:4px 8px; background:Canvas;
    border-top:1px solid color-mix(in srgb, CanvasText 14%, Canvas) }
  .view-controls button { background:transparent; color:CanvasText; font-size:13px; padding:5px 9px; min-width:30px }
  .view-controls button:hover { background:color-mix(in srgb, CanvasText 8%, Canvas) }
  .view-controls span { font:12px/1.5 ui-monospace,monospace; min-width:4ch; text-align:center }
  .edit-tools { display:flex; flex-wrap:wrap; align-items:center; gap:.4rem; margin-top:1rem }
  .edit-tools[hidden] { display:none }
  .edit-tools button,.edit-tools select { color:CanvasText; background:Canvas; font:inherit; font-size:.85rem;
    border:1px solid color-mix(in srgb,CanvasText 25%,Canvas); border-radius:5px; padding:.3rem .55rem }
  .edit-tools span { margin-inline-start:auto; font-size:.8rem }
  .node-card {cursor:grab; -webkit-user-select:none}
  .port {width:10px;height:10px;cursor:crosshair}
  .world path[data-edge-id] {pointer-events:stroke;cursor:pointer;stroke-width:3}
  .world path.selected-edge,.world path.wire-preview {stroke:#518fe4;stroke-width:4}
  .world path.wire-preview {pointer-events:none;stroke-dasharray:6 3}
`;
