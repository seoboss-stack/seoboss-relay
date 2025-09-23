/* SEOBoss Widget V2 — runs on any Shopify theme page, proxies via /apps/engine/v2/* */
(() => {
  // ---- guard: only run on Shopify storefront (any page) ----
  const shop = (window.Shopify && Shopify.shop) || '';
  if (!shop) {
    console.error('[SEOBoss] Must run on a Shopify storefront (window.Shopify.shop missing).');
    return;
  }

  // ---- mount point ----
  const root = document.getElementById('seoboss-console');
  if (!root) {
    console.error('[SEOBoss] #seoboss-console not found.');
    return;
  }

  // ---- config / helpers ----
  const ensureProxy = (p) => {
    if (!p.startsWith('/apps/engine/')) throw new Error('Blocked non-proxy URL: ' + p);
    return p;
  };

  const CONFIG = {
    endpoints: {
      alive:  ensureProxy('/apps/engine/_alive'),
      hints:  ensureProxy('/apps/engine/v2/hints'),         // GET
      titles: ensureProxy('/apps/engine/v2/blog-titles'),   // POST
      post:   ensureProxy('/apps/engine/v2/blog-post')      // POST
    },
    timeoutMs: 120000,
    ui: { themeClass: 'seoboss-v2' },
    version: 'v2.0.0'
  };

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const h = (tag, attrs = {}, html = '') => {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      if (k === 'class') el.className = v;
      else if (k.startsWith('data-')) el.setAttribute(k, v);
      else el[k] = v;
    });
    if (html) el.innerHTML = html;
    return el;
  };
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  // ---- resolve client identity ----
  const clientFromAttr = (root.getAttribute('data-client-id') || '').trim();
  // Prefer explicit client_id; else fall back to shop domain (safe for multi-tenant as long as your backend uses shop as tenant key)
  const CLIENT_ID = clientFromAttr || shop;

  const publishDefault = (root.getAttribute('data-publish-default') || 'false') === 'true';

  // ---- minimal styles (scoped) ----
  const style = h('style', {}, `
  .${CONFIG.ui.themeClass} { font-family: system-ui, -apple-system, Segoe UI, Roboto, Inter, sans-serif; color:#e8fff6; }
  .${CONFIG.ui.themeClass} .panel { background:#0f1421; border:1px solid rgba(255,255,255,.08); border-radius:16px; padding:16px; box-shadow:0 0 24px rgba(66,255,210,.15); }
  .${CONFIG.ui.themeClass} .row { display:flex; gap:10px; flex-wrap:wrap; }
  .${CONFIG.ui.themeClass} input, .${CONFIG.ui.themeClass} textarea { width:100%; min-height:44px; padding:12px; border-radius:10px; border:1px solid rgba(255,255,255,.16); background:rgba(255,255,255,.06); color:#fff; }
  .${CONFIG.ui.themeClass} .btn { display:inline-flex; align-items:center; justify-content:center; gap:.4rem; padding:.8rem 1.2rem; border-radius:999px; border:0; cursor:pointer; font-weight:800; }
  .${CONFIG.ui.themeClass} .btn-primary { background:linear-gradient(90deg,#42ffd2,#6aa8ff); color:#031b17; }
  .${CONFIG.ui.themeClass} .btn-ghost { background:rgba(255,255,255,.06); color:#fff; border:1px solid rgba(255,255,255,.12); }
  .${CONFIG.ui.themeClass} .hints { display:flex; gap:.5rem; flex-wrap:wrap; margin-top:8px; }
  .${CONFIG.ui.themeClass} .chip { background:rgba(66,255,210,.16); border:1px solid rgba(66,255,210,.32); color:#eafff7; padding:.5rem .8rem; border-radius:12px; cursor:pointer; }
  .${CONFIG.ui.themeClass} .log { background:rgba(0,0,0,.55); border:1px solid rgba(255,255,255,.08); border-radius:12px; padding:10px; margin-top:10px; min-height:100px; max-height:220px; overflow:auto; font-family: ui-monospace,Consolas,Menlo,monospace; }
  .${CONFIG.ui.themeClass} .titles { margin-top:10px; display:grid; gap:10px; }
  .${CONFIG.ui.themeClass} .title-card { border:1px solid rgba(66,255,210,.25); background:rgba(255,255,255,.05); border-radius:12px; padding:10px; cursor:pointer; }
  .${CONFIG.ui.themeClass} .title-card.selected { outline:2px solid #42ffd2; }
  `);
  document.head.appendChild(style);

  // ---- UI skeleton ----
  root.classList.add(CONFIG.ui.themeClass);
  root.innerHTML = '';
  const panel = h('div', { class: 'panel' });
  panel.innerHTML = `
    <div class="header">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <h3 style="margin:0;color:#42ffd2;">SEOBoss Console (V2)</h3>
        <small style="opacity:.85">Shop: ${shop}</small>
      </div>
      <p style="margin:.3rem 0 .8rem;opacity:.9">Generate a Shopify-ready blog draft in under a minute.</p>
    </div>

    <form id="kwForm" class="row" novalidate>
      <input id="kwInput" type="text" placeholder="Loading hint…" required />
      <button type="submit" class="btn btn-primary">🚀 Get Title Suggestions</button>
      <button id="resetBtn" type="button" class="btn btn-ghost">Reset</button>
    </form>

    <div id="hints" class="hints"></div>
    <div id="log" class="log" aria-live="polite"><div>Awaiting command…</div></div>
    <div id="titles" class="titles" style="display:none;"></div>

    <div id="final" style="display:none;margin-top:12px;">
      <div class="row">
        <input id="finalTitle" type="text" placeholder="Blog Title" />
      </div>
      <div class="row">
        <input id="metaTitle" type="text" maxlength="70" placeholder="Meta Title (≤ 70 chars)"/>
      </div>
      <div class="row">
        <textarea id="metaDesc" rows="3" maxlength="160" placeholder="Meta Description (≤ 160 chars)"></textarea>
      </div>
      <label style="display:inline-flex;gap:.4rem;align-items:center;margin:.4rem 0;">
        <input id="publishToggle" type="checkbox" ${publishDefault ? 'checked' : ''}/> Publish immediately
      </label>
      <div class="row">
        <button id="genBtn" class="btn btn-primary">📝 Generate Article</button>
      </div>
    </div>

    <div id="output" style="display:none;margin-top:12px;">
      <h4 style="margin:.2rem 0;">Blog Agent Output</h4>
      <div id="content" style="background:#0b0f14;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px;"></div>
      <div id="live" style="margin-top:8px;display:none;">✅ Live: <a id="liveUrl" href="#" target="_blank" rel="noopener"></a></div>
    </div>
  `;
  root.appendChild(panel);

  // ---- refs ----
  const kwForm = $('#kwForm', panel);
  const kwInput = $('#kwInput', panel);
  const resetBtn = $('#resetBtn', panel);
  const logBox = $('#log', panel);
  const hintsBox = $('#hints', panel);
  const titlesBox = $('#titles', panel);
  const finalBox = $('#final', panel);
  const outputBox = $('#output', panel);
  const contentBox = $('#content', panel);
  const liveWrap = $('#live', panel);
  const liveUrl = $('#liveUrl', panel);
  const finalTitle = $('#finalTitle', panel);
  const metaTitle = $('#metaTitle', panel);
  const metaDesc = $('#metaDesc', panel);
  const publishToggle = $('#publishToggle', panel);
  const genBtn = $('#genBtn', panel);

  const state = { selectedMeta: null, fetchCtrl: null };

  function log(line) {
    const d = h('div', {}, String(line));
    logBox.appendChild(d);
    logBox.scrollTop = logBox.scrollHeight;
  }
  function resetAll() {
    logBox.innerHTML = '<div>Awaiting command…</div>';
    titlesBox.innerHTML = '';
    titlesBox.style.display = 'none';
    finalBox.style.display = 'none';
    outputBox.style.display = 'none';
    liveWrap.style.display = 'none';
    state.selectedMeta = null;
    kwInput.value = '';
    kwInput.focus();
  }
  resetBtn.addEventListener('click', resetAll);

  async function fetchJSON(url, { method='GET', body, signal } = {}) {
    const headers = { 'Content-Type': 'application/json', 'X-SeoBoss-Version': CONFIG.version, 'X-Client-ID': CLIENT_ID };
    const resp = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal });
    if (!resp.ok) {
      const txt = await resp.text().catch(()=> '');
      throw new Error(`HTTP ${resp.status} ${resp.statusText}${txt ? ` — ${txt.slice(0,180)}`:''}`);
    }
    return resp.json();
  }

  // ---- Hints (GET) ----
  async function initHints() {
    try {
      const r = await Promise.race([
        fetch(CONFIG.endpoints.hints, { method: 'GET' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), CONFIG.timeoutMs))
      ]);
      const d = await r.json();
      const hints = d.hints || ['keyword ideas', 'on-page SEO basics', 'content strategy tips', 'how to boost Shopify traffic'];
      kwInput.placeholder = hints[0] || 'Enter your keyword…';
      hintsBox.innerHTML = hints.map(hh => `<span class="chip">${hh}</span>`).join('');
      hintsBox.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { kwInput.value = c.textContent; kwInput.focus(); }));
    } catch {
      kwInput.placeholder = 'Enter your keyword…';
      hintsBox.innerHTML = '';
    }
  }

  // ---- Titles (POST) ----
  kwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const kw = kwInput.value.trim();
    if (!kw) return kwInput.focus();

    titlesBox.innerHTML = ''; titlesBox.style.display = 'none';
    finalBox.style.display = 'none'; outputBox.style.display = 'none';
    liveWrap.style.display = 'none';
    state.selectedMeta = null;
    logBox.innerHTML = ''; log('▶ Requesting title shortlist…');

    try {
      const payload = { input_keyword: kw, client_id: CLIENT_ID, shop };
      const data = await fetchJSON(CONFIG.endpoints.titles, { method: 'POST', body: payload });
      const titles = data.titles || [];
      if (!titles.length) throw new Error('No titles returned.');

      titlesBox.style.display = 'grid';
      titlesBox.innerHTML = titles.map((t, i) => `
        <div class="title-card" data-i="${i}">
          <strong>${t.title || 'Untitled'}</strong><br/>
          <em>${t.meta_title || '— meta title —'}</em><br/>
          <small>${t.meta_description || '— meta description —'}</small>
        </div>
      `).join('');

      const metas = titles.map(t => ({
        title: t.title || '',
        meta_title: t.meta_title || '',
        meta_description: t.meta_description || '',
        summary_html: t.summary_html || '',
        faq_json: t.faq_json || '',
        slug: t.slug || '',
        tags: t.tags || '',
        keywords: t.keywords || [],
        category: t.category || ''
      }));

      titlesBox.querySelectorAll('.title-card').forEach(card => {
        card.addEventListener('click', () => {
          titlesBox.querySelectorAll('.title-card').forEach(n => n.classList.remove('selected'));
          card.classList.add('selected');
          const idx = parseInt(card.getAttribute('data-i'), 10);
          state.selectedMeta = metas[idx];
          finalTitle.value = metas[idx].title || '';
          metaTitle.value = metas[idx].meta_title || '';
          metaDesc.value = metas[idx].meta_description || '';
          finalBox.style.display = 'block';
        });
      });

      log('✓ Shortlist ready. Select one to continue.');
    } catch (err) {
      log('Error: ' + (err?.message || 'Unknown'));
    }
  });

  // ---- Generate Article (POST) ----
  genBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!state.selectedMeta) { log('Select a title first.'); return; }
    log('▶ Generating article…');

    try {
      const meta = state.selectedMeta;
      const payload = {
        client_id: CLIENT_ID,
        shop,
        title: (finalTitle.value || meta.title || ''),
        meta_title: (metaTitle.value || meta.meta_title || ''),
        meta_description: (metaDesc.value || meta.meta_description || ''),
        tags: meta.tags || '',
        summary_html: meta.summary_html || '',
        author: 'SEOBoss',
        published: !!publishToggle.checked,
        metafields: { custom: { faq_json: meta.faq_json || '' } },
        slug: meta.slug || ''
      };

      const blog = await fetchJSON(CONFIG.endpoints.post, { method: 'POST', body: payload });
      const html = blog.body_html || blog.articleHtml || '<p>No blog content returned.</p>';
      contentBox.innerHTML = html; // (optional: sanitize with DOMPurify if you want)
      outputBox.style.display = 'block';

      const url = blog.url || blog.link || blog.permalink || (blog.post && blog.post.url) || '';
      if (url) { liveUrl.href = url; liveUrl.textContent = url; liveWrap.style.display = 'block'; }

      log('✓ Article ready.');
    } catch (err) {
      log('Error: ' + (err?.message || 'Unknown'));
    }
  });

  // ---- Health badge (optional) ----
  (async () => {
    try {
      const r = await fetch(CONFIG.endpoints.alive, { method: 'GET' });
      if (r.ok) log('✅ Proxy alive.');
    } catch {/* ignore */}
  })();

  // ---- boot ----
  initHints();
})();
