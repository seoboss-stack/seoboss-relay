<!-- /engine/widget.js (served from hooks.seoboss.com) -->
<script>
(() => {
  if (window.__SEOBOSS_WIDGET__) return;
  window.__SEOBOSS_WIDGET__ = true;

  const host = document.getElementById('seoboss-console');
  if (!host) return console.warn('[SEOBoss] host <div id="seoboss-console"> not found');

  // Mount point expected by your engine
  if (!document.getElementById('seoboss-root')) {
    const root = document.createElement('div');
    root.id = 'seoboss-root';
    host.appendChild(root);
  }

  // Optional: persist client/shop hints (your engine reads from DOM/localStorage later)
  const clientId = host.getAttribute('data-client-id') || '';
  const shop     = host.getAttribute('data-shop') || '';
  try {
    const prev = JSON.parse(localStorage.getItem('seoboss:client') || '{}');
    localStorage.setItem('seoboss:client', JSON.stringify({ ...prev, id: clientId, shop_url: shop }));
  } catch {}

  // Your engine expects to work at /apps/engine; the proxy already maps that.
  window.CONFIG = window.CONFIG || {};
  window.CONFIG.endpoints = window.CONFIG.endpoints || {
    hints:  "/apps/engine/hints",
    titles: "/apps/engine/blog-titles",
    post:   "/apps/engine/blog-post",
    alive:  "/apps/engine/_alive"
  };

  // 🔗 Use the exact Shopify CDN URLs you grabbed in DevTools
  const CSS_URL = "https://cdn.shopify.com/extensions/019a36ae-dbc4-7a9f-9592-6a7a28009252/seoboss-cli-244/assets/seoboss-engine.css";
  const JS_URL  = "https://cdn.shopify.com/extensions/019a36ae-dbc4-7a9f-9592-6a7a28009252/seoboss-cli-244/assets/seoboss-engine.js";

  // Load CSS first
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = CSS_URL;
  document.head.appendChild(link);

  // Then load your engine JS (it bootstraps itself on DOMContentLoaded and looks for #seoboss-root)
  const scr = document.createElement('script');
  scr.src = JS_URL;
  scr.defer = true;
  document.head.appendChild(scr);
})();
</script>
