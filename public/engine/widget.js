// /engine/widget.js  (no <script> wrapper)
(() => {
  if (window.__SEOBOSS_WIDGET__) return;
  window.__SEOBOSS_WIDGET__ = true;

  const host = document.getElementById('seoboss-console');
  if (!host) return console.warn('[SEOBoss] <div id="seoboss-console"> not found');

  // Ensure inner mount
  let root = document.getElementById('seoboss-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'seoboss-root';
    host.appendChild(root);
  }

  /* ---------- CSS: kill inner scroll/boxing ---------- */
  (function injectCss(){
    const s = document.createElement('style');
    s.textContent = `
      html, body { margin:0 !important; background:transparent !important; }
      #seoboss-console, #seoboss-root { display:block; width:100%; min-height:100vh; }
      /* Neutralize any fixed-height shells inside the engine */
      #seoboss-root .app-shell, #seoboss-root .engine-shell {
        height:auto !important; min-height:100vh !important; overflow:visible !important;
      }
    `;
    document.head.appendChild(s);
  })();

  // Persist hints (optional)
  const clientId = host.getAttribute('data-client-id') || '';
  const shop     = host.getAttribute('data-shop') || '';
  try {
    const prev = JSON.parse(localStorage.getItem('seoboss:client') || '{}');
    localStorage.setItem('seoboss:client', JSON.stringify({ ...prev, id: clientId, shop_url: shop }));
  } catch {}

  // Engine endpoints (App Proxy)
  window.CONFIG = window.CONFIG || {};
  window.CONFIG.endpoints = window.CONFIG.endpoints || {
    hints:  "/apps/engine/hints",
    titles: "/apps/engine/blog-titles",
    post:   "/apps/engine/blog-post",
    alive:  "/apps/engine/_alive"
  };

  // Load engine CSS/JS (cache-busted)
  const CSS_URL = "/apps/engine/assets/seoboss-engine.css";
  const JS_URL  = "/apps/engine/assets/seoboss-engine.js";
  const bust    = `?v=${Date.now()}`;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = CSS_URL + bust;
  document.head.appendChild(link);

  const scr = document.createElement('script');
  scr.src = JS_URL + bust;
  scr.defer = true;
  document.head.appendChild(scr);

  /* ---------- Height → parent (must match admin listener) ---------- */
  const sendHeight = () => {
    const h = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
      document.documentElement.offsetHeight,
      document.body.offsetHeight
    );
    // MUST match the parent listener type:
    parent.postMessage({ type: 'seoboss:height', height: h }, '*');
  };

  const schedule = () => requestAnimationFrame(sendHeight);

  window.addEventListener('load', schedule);
  window.addEventListener('resize', schedule);
  if (document.fonts?.ready) document.fonts.ready.then(schedule).catch(()=>{});

  if ('ResizeObserver' in window) {
    new ResizeObserver(schedule).observe(document.body);
  }
  if ('MutationObserver' in window) {
    new MutationObserver(schedule).observe(document.body, { childList:true, subtree:true, attributes:true });
  }
  setInterval(schedule, 1200); // gentle heartbeat
  sendHeight(); // initial ping
})();
