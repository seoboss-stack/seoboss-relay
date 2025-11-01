<!-- /engine/widget.js -->
<script>
(() => {
  if (window.__SEOBOSS_WIDGET__) return;
  window.__SEOBOSS_WIDGET__ = true;

  const host = document.getElementById('seoboss-console');
  if (!host) return console.warn('[SEOBoss] host <div id="seoboss-console"> not found');

  // Ensure an inner mount
  if (!document.getElementById('seoboss-root')) {
    const root = document.createElement('div');
    root.id = 'seoboss-root';
    host.appendChild(root);
  }

  /* --- 🔧 Scroll/height fix (inject CSS overrides) ------------------------ */
  (function injectFullscreenCss(){
    const s = document.createElement('style');
    s.textContent = `
      html, body, #seoboss-console, #seoboss-root {
        height: auto !important;
        min-height: 100vh !important;
        overflow: visible !important;
      }
      /* If your engine shell/container enforces its own scroll, neutralize it */
      #seoboss-root, #seoboss-root *[data-engine-shell],
      #seoboss-root .engine-shell, #seoboss-root .app-shell {
        height: auto !important;
        min-height: 100vh !important;
        overflow: visible !important;
      }
    `;
    document.head.appendChild(s);
  })();
  /* ----------------------------------------------------------------------- */

  // (Optional) persist hints
  const clientId = host.getAttribute('data-client-id') || '';
  const shop     = host.getAttribute('data-shop') || '';
  try {
    const prev = JSON.parse(localStorage.getItem('seoboss:client') || '{}');
    localStorage.setItem('seoboss:client', JSON.stringify({ ...prev, id: clientId, shop_url: shop }));
  } catch {}

  // Endpoints your engine expects (proxied via App Proxy)
  window.CONFIG = window.CONFIG || {};
  window.CONFIG.endpoints = window.CONFIG.endpoints || {
    hints:  "/apps/engine/hints",
    titles: "/apps/engine/blog-titles",
    post:   "/apps/engine/blog-post",
    alive:  "/apps/engine/_alive"
  };

  // Load your already-working Shopify-hosted assets
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

  /* --- (Optional) If App Bridge UMD is present, auto-resize the iframe ---- */
  try {
    const ab = window.appBridge;
    const hostParam = new URLSearchParams(location.search).get('host') || '';
    if (ab?.createApp && hostParam) {
      const app = ab.createApp({ apiKey: 'YOUR_PUBLIC_API_KEY', host: hostParam });
      const { actions } = ab;
      const size = actions.Size.create(app);
      const sync = () => size.dispatch(actions.Size.Action.RESIZE, { height: document.documentElement.scrollHeight });
      window.addEventListener('load', sync);
      new ResizeObserver(sync).observe(document.body);
    }
  } catch {}
  /* ----------------------------------------------------------------------- */
})();
</script>
