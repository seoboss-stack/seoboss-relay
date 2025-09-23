// SEOBoss widget bootloader (public/engine/widget.js)
(() => {
  // guard
  if (window.__SEOBOSS_WIDGET__) return; 
  window.__SEOBOSS_WIDGET__ = true;

  // Find the host div (first one wins)
  const host = document.getElementById('seoboss-console');
  if (!host) return console.warn('[SEOBoss] <div id="seoboss-console"> not found');

  // Read data attributes (client-id is important)
  const clientId = host.getAttribute('data-client-id') || '';
  const shop     = host.getAttribute('data-shop') || '';

  // Persist client for engine to read (same key your app uses)
  try {
    const prev = JSON.parse(localStorage.getItem('seoboss:client') || '{}');
    const merged = { ...prev, id: clientId, shop_url: shop };
    localStorage.setItem('seoboss:client', JSON.stringify(merged));
  } catch {}

  // Publish minimal config for the core script
  window.SEO_BOSS_CONFIG = {
    // Force Shopify App Proxy endpoints
    endpoints: {
      hints:  "/apps/engine/hints",
      titles: "/apps/engine/blog-titles",
      post:   "/apps/engine/blog-post",
      alive:  "/apps/engine/_alive"
    },
    version: "widget-1"
  };

  // Inject CSS
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = new URL('./widget.css', import.meta.url).toString();
  document.head.appendChild(css);

  // Inject engine core (your big UI/logic lives there)
  const core = document.createElement('script');
  core.src = new URL('./engine-core.js', import.meta.url).toString();
  core.defer = true;
  document.head.appendChild(core);
})();
