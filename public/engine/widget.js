// SEOBoss widget bootloader
(() => {
  if (window.__SEOBOSS_WIDGET__) return;
  window.__SEOBOSS_WIDGET__ = true;

  const host = document.getElementById('seoboss-console');
  if (!host) return console.warn('[SEOBoss] host <div id="seoboss-console"> not found');

  const clientId = host.getAttribute('data-client-id') || '';
  const shop     = host.getAttribute('data-shop') || '';

  try {
    const prev = JSON.parse(localStorage.getItem('seoboss:client') || '{}');
    localStorage.setItem('seoboss:client', JSON.stringify({ ...prev, id: clientId, shop_url: shop }));
  } catch {}

  window.SEO_BOSS_CONFIG = {
    endpoints: {
      hints:  "/apps/engine/hints",
      titles: "/apps/engine/blog-titles",
      post:   "/apps/engine/blog-post",
      alive:  "/apps/engine/_alive"
    },
    version: "widget-1"
  };

  // styles
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = new URL('./widget.css', import.meta.url).toString();
  document.head.appendChild(css);

  // engine core
  const core = document.createElement('script');
  core.src = new URL('./engine-core.js', import.meta.url).toString();
  core.defer = true;
  document.head.appendChild(core);
})();
