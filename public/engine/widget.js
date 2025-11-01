<!-- /engine/widget.js (served by /apps/engine/widget.js) -->
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

  // ---------- Resolve tenant (from data-attrs, QS fallback, then cache) ----------
  const qs = new URLSearchParams(location.search);
  let clientId = (host.getAttribute('data-client-id') || qs.get('client_id') || '').trim();
  let shop     = (host.getAttribute('data-shop') || qs.get('shop') || '').trim().toLowerCase();

  const perShopKey = s => `seoboss:client:${(s||'').toLowerCase()}`;

  // Migrate legacy global cache → namespaced
  try {
    const legacy = localStorage.getItem('seoboss:client');
    if (legacy) {
      const parsed = JSON.parse(legacy || '{}');
      const lshop = (parsed.shop_url || '').toLowerCase();
      if (lshop && !localStorage.getItem(perShopKey(lshop))) {
        localStorage.setItem(perShopKey(lshop), JSON.stringify(parsed));
      }
    }
  } catch {}

  // If attrs/QS missing, try cache
  try {
    if ((!clientId || !shop) && shop) {
      const cached = JSON.parse(localStorage.getItem(perShopKey(shop)) || '{}');
      clientId = clientId || cached.id || '';
      shop     = shop     || cached.shop_url || shop;
    }
  } catch {}

  // Persist (don’t clobber a good cache)
  try {
    if (clientId && shop) {
      const k = perShopKey(shop);
      const ex = JSON.parse(localStorage.getItem(k) || '{}');
      if (!ex.id || !ex.shop_url) localStorage.setItem(k, JSON.stringify({ ...ex, id: clientId, shop_url: shop }));
      // keep legacy updated too (harmless)
      localStorage.setItem('seoboss:client', JSON.stringify({ id: clientId, shop_url: shop }));
    }
  } catch {}

  // ---------- Endpoints (append ?client_id=&shop= to ALL) ----------
  window.CONFIG = window.CONFIG || {};
  (function(){
    const q = `?client_id=${encodeURIComponent(clientId||'')}` + (shop ? `&shop=${encodeURIComponent(shop)}` : '');
    window.CONFIG.endpoints = window.CONFIG.endpoints || {
      // content
      hints:          "/apps/engine/hints"             + q,
      titles:         "/apps/engine/blog-titles"       + q,
      post:           "/apps/engine/blog-post"         + q,
      alive:          "/apps/engine/_alive"            + q,

      // vault
      vaultList:      "/apps/engine/v3/vault/list"     + q,
      vaultAdd:       "/apps/engine/v3/vault/add"      + q,
      vaultUpdate:    "/apps/engine/v3/vault/update"   + q,
      vaultDelete:    "/apps/engine/v3/vault/delete"   + q,

      // billing / usage / jobs  🔧 these were missing before
      billingStatus:  "/apps/engine/v3/billing/status"    + q,
      billingAllow:   "/apps/engine/v3/billing/allow"     + q,
      billingSubscribe:"/apps/engine/v3/billing/subscribe"+ q,
      usageMark:      "/apps/engine/v3/usage/mark"        + q,
      jobStart:       "/apps/engine/v3/job/start"         + q,
      jobResult:      "/apps/engine/v3/job/result"        + q
    };
  })();

  // ---------- Assets (your Shopify CDN bundle) ----------
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

  // ---------- (Optional) iframe height sync for embedded contexts ----------
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
    try { window.parent.postMessage({ type:'seoboss:height', height: Math.max(700, h) }, '*'); } catch {}
  }
  window.addEventListener('load', postHeight);
  document.addEventListener('DOMContentLoaded', postHeight);
  window.addEventListener('resize', postHeight);

  console.log('[SEOBoss] widget mounted', { shop, clientId });
})();
</script>
