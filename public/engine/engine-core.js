// SEOBoss Engine Core (public/engine/engine-core.js)
(() => {
  // Optional: read config from widget
  const CFG = window.SEO_BOSS_CONFIG || {
    endpoints: {
      hints:  "/apps/engine/hints",
      titles: "/apps/engine/blog-titles",
      post:   "/apps/engine/blog-post",
      alive:  "/apps/engine/_alive"
    }
  };

  // ======= REPLACE THIS BLOCK WITH YOUR EXISTING ENGINE SCRIPT =======
  // For now we just show a tiny placeholder so you can verify the widget loads.
  const root = document.getElementById('seoboss-console');
  if (!root) return;

  const box = document.createElement('div');
  box.className = 'seoboss-placeholder';
  box.innerHTML = `
    <div class="seoboss-card">
      <div class="title">SEOBoss Engine</div>
      <div class="meta">Proxy: <code>${CFG.endpoints.hints}</code></div>
      <button id="sb-check" class="btn">Check connection</button>
      <div id="sb-result" class="result"></div>
    </div>
  `;
  root.appendChild(box);

  document.getElementById('sb-check')?.addEventListener('click', async () => {
    const out = document.getElementById('sb-result');
    out.textContent = 'Pinging…';
    try {
      const r = await fetch(CFG.endpoints.alive || '/apps/engine/_alive');
      const d = await r.json();
      out.textContent = (r.ok ? '✅ ' : '❌ ') + JSON.stringify(d);
    } catch (e) {
      out.textContent = '❌ ' + (e.message || 'Failed');
    }
  });

  // ======= END REPLACE BLOCK =======
})();
