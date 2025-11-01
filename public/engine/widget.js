<!-- /engine/widget.js (served from hooks.seoboss.com) -->
<script>
(() => {
  if (window.__SEOBOSS_WIDGET__) return;
  window.__SEOBOSS_WIDGET__ = true;

  const host = document.getElementById('seoboss-console');
  if (!host) return console.warn('[SEOBoss] host <div id="seoboss-console"> not found');

  // Ensure inner mount point
  if (!document.getElementById('seoboss-root')) {
    const root = document.createElement('div');
    root.id = 'seoboss-root';
    host.appendChild(root);
  }

  // ---- Namespaced cache (per shop) + no-blank writes ----
  const clientId = (host.getAttribute('data-client-id') || '').trim();
  const shop     = (host.getAttribute('data-shop') || '').trim().toLowerCase();
  const keyFor   = s => `seoboss:client:${(s||'').toLowerCase()}`;

  // Migrate legacy global once (read-only)
  try {
    const legacy = localStorage.getItem('seoboss:client');
    if (legacy) {
      const parsed = JSON.parse(legacy || '{}');
      const legacyShop = (parsed.shop_url || '').toLowerCase();
      if (legacyShop && !localStorage.getItem(keyFor(legacyShop))) {
        localStorage.setItem(keyFor(legacyShop), JSON.stringify(parsed));
      }
    }
  } catch {}

  // Only persist if BOTH values are present; don’t clobber an existing good cache
  try {
    if (clientId && shop) {
      const k = keyFor(shop);
      const existing = JSON.parse(localStorage.getItem(k) || '{}');
      if (!existing.id || !existing.shop_url) {
        localStorage.setItem(k, JSON.stringify({ ...existing, id: clientId, shop_url: shop }));
      }
    }
  } catch {}

  // ---- Endpoints (won’t overwrite if already set elsewhere) ----
  window.CONFIG = window.CONFIG || {};
  window.CONFIG.endpoints = window.CONFIG.endpoints || {
    hints:  "/apps/engine/hints",
    titles: "/apps/engine/blog-titles",
    post:   "/apps/engine/blog-post",
    alive:  "/apps/engine/_alive"
  };

  // ---- Assets (your exact Shopify CDN URLs) ----
  const CSS_URL = "https://cdn.shopify.com/extensions/019a36ae-dbc4-7a9f-9592-6a7a28009252/seoboss-cli-244/assets/seoboss-engine.css";
  const JS_URL  = "https://cdn.shopify.com/extensions/019a36ae-dbc4-7a9f-9592-6a7a28009252/seoboss-cli-244/assets/seoboss-engine.js";

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = CSS_URL;
  link.onerror = () => console.warn('[SEOBoss] CSS failed to load:', CSS_URL);
  document.head.appendChild(link);

  const scr = document.createElement('script');
  scr.src = JS_URL;
  scr.defer = true;
  scr.onerror = () => console.warn('[SEOBoss] JS failed to load:', JS_URL);
  document.head.appendChild(scr);

  // ---- Optional: report height to parent (fixes short iframe on Onboarding page) ----
  const inIFrame = (() => { try { return window.parent && window.parent !== window; } catch { return false; }})();
  function postHeight(){
    if (!inIFrame) return;
    const h = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
      document.documentElement.offsetHeight,
      document.body.offsetHeight,
      window.innerHeight || 0
    );
    try { window.parent.postMessage({ type:'seoboss:height', height: Math.max(600, h) }, '*'); } catch {}
  }
  window.addEventListener('load', postHeight);
  document.addEventListener('DOMContentLoaded', postHeight);
  window.addEventListener('resize', postHeight);
})();
</script>
