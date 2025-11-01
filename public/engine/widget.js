// /engine/widget.js  (no <script> wrapper)
(() => {
  if (window.__SEOBOSS_WIDGET__) return;
  window.__SEOBOSS_WIDGET__ = true;

  /* ─────────────────────────────
   * Host + Mount
   * ───────────────────────────── */
  const HOST_ID = 'seoboss-console';
  const host = document.getElementById(HOST_ID);
  if (!host) return console.warn('[SEOBoss] <div id="seoboss-console"> not found');

  // Ensure inner mount
  let root = document.getElementById('seoboss-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'seoboss-root';
    host.appendChild(root);
  }

  /* ─────────────────────────────
   * Styling (idempotent)
   * ───────────────────────────── */
  (function injectCss(){
    if (document.getElementById('seoboss-widget-css')) return;
    const s = document.createElement('style');
    s.id = 'seoboss-widget-css';
    s.textContent = `
      html, body { margin:0 !important; background:transparent !important; }
      #${HOST_ID}, #seoboss-root { display:block; width:100%; min-height:100vh; }
      /* Neutralize any fixed-height shells inside the engine */
      #seoboss-root .app-shell, #seoboss-root .engine-shell {
        height:auto !important; min-height:100vh !important; overflow:visible !important;
      }
    `;
    document.head.appendChild(s);
  })();

  /* ─────────────────────────────
   * Persist client hints (optional)
   * ───────────────────────────── */
  const clientId = host.getAttribute('data-client-id') || '';
  const shop     = host.getAttribute('data-shop') || '';
  try {
    const prev = JSON.parse(localStorage.getItem('seoboss:client') || '{}');
    localStorage.setItem('seoboss:client', JSON.stringify({ ...prev, id: clientId, shop_url: shop }));
  } catch {}

  /* ─────────────────────────────
   * Endpoints (App Proxy)
   * ───────────────────────────── */
  const DEF_ENDPOINTS = {
    hints:  "/apps/engine/hints",
    titles: "/apps/engine/blog-titles",
    post:   "/apps/engine/blog-post",
    alive:  "/apps/engine/_alive"
  };
  // Respect existing CONFIG/endpoints, merge defaults
  window.CONFIG = window.CONFIG || {};
  window.CONFIG.endpoints = { ...(window.CONFIG.endpoints || {}), ...DEF_ENDPOINTS };

  /* ─────────────────────────────
   * Asset loader (cache-busted)
   * ───────────────────────────── */
  // Optional deterministic version via data-version, else Date.now()
  const ver = host.getAttribute('data-version') || String(Date.now());
  const CSS_URL = "/apps/engine/assets/seoboss-engine.css";
  const JS_URL  = "/apps/engine/assets/seoboss-engine.js";

  function loadCss(href) {
    // avoid duplicate <link>
    const already = [...document.querySelectorAll('link[rel="stylesheet"]')].some(l => l.href.includes(CSS_URL));
    if (already) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onerror = () => console.warn('[SEOBoss] CSS failed to load:', href);
    document.head.appendChild(link);
  }

  function loadJs(src) {
    // avoid duplicate <script>
    const already = [...document.querySelectorAll('script')].some(s => s.src && s.src.includes(JS_URL));
    if (already) return;
    const scr = document.createElement('script');
    scr.src = src;
    scr.defer = true;
    scr.onerror = () => console.warn('[SEOBoss] JS failed to load:', src);
    scr.onload  = schedule;
    document.head.appendChild(scr);
  }

  loadCss(`${CSS_URL}?v=${encodeURIComponent(ver)}`);
  loadJs(`${JS_URL}?v=${encodeURIComponent(ver)}`);

  /* ─────────────────────────────
   * Height → parent (robust)
   * ───────────────────────────── */
  const inIFrame = (() => {
    try { return window.parent && window.parent !== window; } catch { return false; }
  })();

  function measureHeight() {
    // Use several fallbacks to cover margins/positioning
    const de = document.documentElement;
    const b  = document.body;

    const rectDoc = de.getBoundingClientRect();
    const rectBody = b.getBoundingClientRect();
    const rectRoot = root.getBoundingClientRect();

    const vals = [
      de.scrollHeight, b.scrollHeight,
      de.offsetHeight, b.offsetHeight,
      rectDoc.height, rectBody.height, rectRoot.height,
      // In some themes, scrollingElement is most accurate
      (document.scrollingElement ? document.scrollingElement.scrollHeight : 0),
    ].filter(Boolean);

    let h = Math.max.apply(null, vals);
    if (!isFinite(h) || h <= 0) h = Math.max(window.innerHeight || 0, 600);
    return Math.ceil(h);
  }

  let rafId = 0;
  function sendHeight() {
    if (!inIFrame) return; // avoid posting to self
    const h = measureHeight();
    try {
      parent.postMessage({ type: 'seoboss:height', height: h }, '*');
    } catch (e) {
      // Some CSPs restrict postMessage—just swallow
    }
  }
  function schedule() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(sendHeight);
  }

  // Initial + typical triggers
  window.addEventListener('load', schedule);
  window.addEventListener('resize', schedule);
  document.addEventListener('DOMContentLoaded', schedule);
  if (document.fonts?.ready) document.fonts.ready.then(schedule).catch(()=>{});

  // Observe root and body for layout changes
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(schedule);
    ro.observe(document.body);
    ro.observe(document.documentElement);
    ro.observe(root);
  }
  if ('MutationObserver' in window) {
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList:true, subtree:true, attributes:true, characterData:true });
    mo.observe(root,         { childList:true, subtree:true, attributes:true, characterData:true });
  }

  // Visibility changes can affect fonts/layout
  document.addEventListener('visibilitychange', schedule);

  // Gentle heartbeat (safe low frequency)
  const beat = setInterval(schedule, 1200);

  // First ping
  schedule();

  /* ─────────────────────────────
   * Simple message protocol (optional)
   * ───────────────────────────── */
  window.addEventListener('message', (e) => {
    const d = e && e.data;
    if (!d || typeof d !== 'object') return;

    // Parent can ask for a fresh height or a pong
    if (d.type === 'seoboss:ping' || d.type === 'seoboss:height:request') {
      schedule();
      try { parent.postMessage({ type:'seoboss:pong', ok:true }, '*'); } catch {}
    }
  });

  // Expose a minimal API for manual refreshes (handy in dev)
  window.__SEOBOSS_WIDGET_API__ = {
    refresh: schedule,
    destroy: () => { try { clearInterval(beat); } catch {} }
  };
})();
