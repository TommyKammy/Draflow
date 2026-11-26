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
  .execution-log summary { cursor:pointer; overflow-wrap:anywhere }
  .execution-log code { display:block; white-space:pre-wrap; overflow-wrap:anywhere; max-height:18rem; overflow:auto }
  pre:empty { display:none }
  .canvas-panel { margin-top:1.25rem; position:relative; border:1px solid color-mix(in srgb, CanvasText 16%, Canvas); border-radius:8px; overflow:clip }
  .canvas { height:clamp(260px,38vh,460px); position:relative; overflow:clip; isolation:isolate;
    background-color:color-mix(in srgb, CanvasText 2%, Canvas);
    background-image:radial-gradient(color-mix(in srgb, CanvasText 16%, Canvas) 1px,transparent 1px);
    background-size:16px 16px; touch-action:none; user-select:none }
  .canvas:focus-visible { outline:2px solid Highlight; outline-offset:-2px }
  .canvas.panning, .canvas.panning * { cursor:grabbing }
  .world { position:absolute; top:0; left:0; transform-origin:0 0; will-change:transform }
  .group-frame {position:absolute;box-sizing:border-box;pointer-events:none;border:2px solid #708da5;border-radius:8px;background:color-mix(in srgb,#708da5 9%,transparent)}
  .group-frame>div {display:flex;align-items:center;gap:4px;width:fit-content;max-width:100%;height:40px;padding:0 4px;pointer-events:auto}
  .group-frame button {max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:Canvas;color:CanvasText;padding:.2rem .45rem}
  .group-frame button+button {cursor:grab;touch-action:none}
  .world .node-card[hidden] {display:none}
  .world svg { position:absolute; top:0; left:0; overflow:visible; pointer-events:none }
  .world path { fill:none; stroke:color-mix(in srgb, CanvasText 49%, Canvas); stroke-width:2 }
  .sticky-card { position:absolute; display:flex; flex-direction:column; box-sizing:border-box; overflow:hidden;
    color:#27231a; background:#f9e8a4; border:1px solid #70664b; border-radius:5px }
  .sticky-card[data-color=blue] {background:#c6dff1}
  .sticky-card[data-color=green] {background:#cce4c4}
  .sticky-card[data-color=pink] {background:#f4cdd7}
  .sticky-grip {height:20px;flex:none;cursor:move;background:#0001;touch-action:none}
  .sticky-grip::after {content:"";display:block;width:2rem;margin:8px auto;border-top:3px double currentColor;opacity:.55}
  .editor:has(.edit-tools[hidden]) .sticky-grip {cursor:default}
  .editor:has(.edit-tools[hidden]) .sticky-grip::after {display:none}
  .sticky-card button {min-height:0;flex:1;padding:.4rem .6rem;border:0;border-radius:0;background:transparent;
    color:inherit;white-space:pre-wrap;overflow:hidden;overflow-wrap:anywhere;text-align:start;align-content:start}
  .sticky-card button:focus-visible {outline-offset:-3px}
  .sticky-dialog {box-sizing:border-box;width:min(24rem,94vw);max-height:90dvh;overflow:auto;background:Canvas;color:CanvasText;border:1px solid GrayText;border-radius:8px}
  .sticky-dialog form {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.6rem}
  .sticky-dialog label {display:grid}
  .sticky-dialog :is(input,textarea,select) {box-sizing:border-box;width:100%;font:inherit}
  .sticky-dialog textarea {min-height:6rem}
  .sticky-dialog label:nth-child(-n+2),.sticky-dialog form>div {grid-column:1/-1}
  .sticky-dialog form>div {display:flex;flex-wrap:wrap;gap:.5rem}
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
  .command-palette {box-sizing:border-box;width:min(26rem,94vw);max-height:90dvh;overflow:auto;background:Canvas;color:CanvasText;border:1px solid GrayText;border-radius:8px}
  .command-palette input {box-sizing:border-box;width:100%;font:inherit;padding:.45rem}
  .command-palette [role=listbox] {margin:.5rem 0;max-height:50dvh;overflow:auto}
  .command-palette [role=option] {padding:.45rem .65rem;cursor:pointer;border-radius:4px}
  .command-palette [aria-selected=true] {background:Highlight;color:HighlightText}
  .command-palette [aria-disabled=true] {color:GrayText;cursor:default}
  .command-palette p:empty {display:none}
  dialog { color-scheme:inherit }
  :where(button,select,input,textarea,summary):focus-visible { outline:2px solid Highlight; outline-offset:2px }
  .node-details { box-sizing:border-box; width:min(74rem,96vw); max-height:90vh; overflow:auto; color:CanvasText; background:Canvas;
    border:1px solid GrayText; border-radius:10px; padding:1rem; overscroll-behavior:contain }
  .node-details::backdrop { background:#0006 }
  .details-panes { display:grid; grid-template-columns:minmax(0,1fr) minmax(16rem,1.4fr) minmax(0,1fr); gap:1rem; margin-top:1rem }
  .details-panes>section {min-width:0}
  .data-scroll,.mapping-fields {overflow:auto;max-height:18rem;max-width:100%}
  .data-scroll table {border-collapse:separate;border-spacing:0;font-size:.85rem}
  .data-scroll th,.data-scroll td {padding:.25rem .5rem;text-align:start;border-bottom:1px solid GrayText;white-space:nowrap}
  .data-scroll thead {position:sticky;top:0;background:Canvas}
  .node-details dl {display:grid;grid-template-columns:auto 1fr;gap:.25rem;overflow:auto}
  .node-details dd {margin:0}
  .details-panes>section mark {background:color-mix(in srgb,Highlight 15%,Canvas);color:CanvasText}
  .details-panes>section>div>div>label {display:inline-flex;align-items:center;gap:.3rem}
  .details-panes input[type=number] {width:6rem}
  .node-details .mapping-fields {display:flex;flex-wrap:wrap;gap:.25rem;margin:.4rem 0}
  .mapping-fields button:not([aria-pressed=true]) {color:CanvasText;background:Canvas;border:1px solid GrayText}
  .node-details:not([data-mapping]) .insert-mapping {display:none}
  .node-details small[data-type]::after {content:" · " attr(data-type);opacity:.7}
  .node-details nav { display:flex; gap:.35rem }
  .node-details nav button:not([aria-pressed=true]) { color:CanvasText; background:Canvas; border:1px solid GrayText }
  .node-details h3,.node-details h4 { margin:.5rem 0 }
  .node-details fieldset { min-width:0; margin:.5rem 0; border:1px solid color-mix(in srgb,CanvasText 20%,Canvas); border-radius:5px }
  .node-details form>fieldset { padding:0; border:0 }
  .node-details label { display:grid; margin:.55rem 0; gap:.2rem; font-size:.9rem }
  .node-details :is(input,select,textarea) { box-sizing:border-box; font:inherit; max-width:100%; padding:.3rem }
  .node-details input[type=checkbox] { justify-self:start }
  .node-details .details-tabs { display:none }
  @media(max-width:760px) {
    .node-details { max-height:92dvh; padding:.75rem }
    .node-details header {justify-content:flex-start; gap:.4rem}
    .node-details button,.node-creator button {min-height:40px}
    .details-panes { display:block }
    .details-panes>section:not(.current) { display:none }
    .node-details .details-tabs { display:flex; margin-top:.5rem }
  }
  .node-creator { box-sizing:border-box; width:min(26rem,92vw); max-height:80vh; overflow:auto; overscroll-behavior:contain;
    padding:1.25rem; background:Canvas; color:CanvasText; border:1px solid GrayText; border-radius:10px }
  .node-creator::backdrop { background:#0006 }
  .node-creator input,.node-creator select { display:block; box-sizing:border-box; width:100%; padding:.45rem; margin:.65rem 0; font:inherit }
  .node-creator h3 { margin:1rem 0 .25rem; font-size:.85rem }
  .node-creator div button { display:block; text-align:start; width:100%; color:CanvasText; background:Canvas }
  .node-creator div button:hover,.node-creator div button:focus-visible { background:color-mix(in srgb,CanvasText 10%,Canvas) }
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
