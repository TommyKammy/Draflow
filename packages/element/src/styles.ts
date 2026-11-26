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
`;
