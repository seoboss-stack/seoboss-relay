<!-- /engine/widget.js -->
<script>
(() => {
  if (window.__SEOBOSS_WIDGET__) return;
  window.__SEOBOSS_WIDGET__ = true;

  const host = document.getElementById('seoboss-console');
  if (!host) return console.warn('[SEOBoss] host <div id="seoboss-console"> not found');

  // Inner mount
  let root = document.getElementById('seoboss-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'seoboss-root';
    host.appendChild(root);
  }

  /* ---------- Minimal CSS to avoid inner scroll/boxing ---------- */
  (function injectCss(){
    const s = document.createElement('style');
    s.textContent = `
      html, body { margin:0 !important; background:transparent !important; }
      #seoboss-console, #seoboss-root { display:block; min-height:100vh; }
      /* If any container in the engine sets fixed heights, neutralize */
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

  // Load engine CSS/JS (use your preferred host)
  const CSS_URL = "/apps/engine/assets/seoboss-engine.css";
  const JS_URL  = "/apps/engine/assets/seoboss-engine.js";

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = CSS_URL;
  document.head.appendChild(link);

  const scr = document.createElement('script');
  scr.src = JS_URL;
  scr.defer = true;
  document.head.appendChild(scr);

  /* ---------- Robust height reporter to parent ---------- */
  function postHeight() {
    const h = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
      document.documentElement.offsetHeight,
      document.body.offsetHeight
    );
    parent.postMessage({ type: 'SEOBOSS_IFRAME_HEIGHT', height: h }, '*');
  }

  const report = () => requestAnimationFrame(postHeight);

  window.addEventListener('load', report);
  window.addEventListener('resize', report);
  if (document.fonts?.ready) document.fonts.ready.then(report).catch(()=>{});

  // Watch layout changes (content expanding)
  if ('ResizeObserver' in window) {
    new ResizeObserver(report).observe(document.body);
  }
  if ('MutationObserver' in window) {
    new MutationObserver(report).observe(document.body, { childList:true, subtree:true, attributes:true });
  }
  // Gentle heartbeat for any missed cases
  setInterval(report, 1200);

  // Let parent know we’re alive right away
  postHeight();
})();
</script>
