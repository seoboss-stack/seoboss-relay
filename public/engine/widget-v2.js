/* SEOBoss Widget V2 — lightweight embed console
   Path: /engine/widget-v2.js (served from hooks.seoboss.com)
   Expects a <div id="seoboss-console" data-client-id="..." data-shop="..."></div> in the DOM.
*/
(() => {
  // ---- singleton guard ----
  if (window.__SEO_BOSS_WIDGET_V2__) {
    console.warn("[SEOBoss] v2 widget already initialized — skipping.");
    return;
  }
  window.__SEO_BOSS_WIDGET_V2__ = true;

  // ---- hard checks: must run on Shopify App Proxy page ----
  const onShopifyProxy = location.pathname.startsWith("/apps/");
  if (!onShopifyProxy) {
    console.error("[SEOBoss] This widget must be embedded on a Shopify App Proxy route (e.g. /apps/engine).");
    return;
  }

  // ---- mount + config ----
  const mount = document.getElementById("seoboss-console");
  if (!mount) {
    console.error("[SEOBoss] Missing #seoboss-console mount.");
    return;
  }

  const ds = mount.dataset || {};
  const CLIENT_ID = (ds.clientId || "").trim();
  const SHOP      = (ds.shop || "").trim();
  const PUBLISH_DEFAULT = String(ds.publishDefault || "") === "true";

  if (!CLIENT_ID && !SHOP) {
    console.warn("[SEOBoss] No client_id or shop provided. Upstream will likely reject writes.");
  }

  // Only allow requests to the app proxy (defense-in-depth)
  const ensureProxy = (p) => {
    if (!p.startsWith("/apps/engine/")) throw new Error("Blocked non-proxy URL: " + p);
    return p;
  };

  // Endpoints for V2
  const CFG = {
    endpoints: {
      hints:  ensureProxy("/apps/engine/v2/hints"),        // GET
      titles: ensureProxy("/apps/engine/v2/blog-titles"),  // POST
      post:   ensureProxy("/apps/engine/v2/blog-post")     // POST
    },
    timeoutMs: 120000,
  };

  // ---- tiny html + styles (self-contained) ----
  const html = `
    <style id="seoboss-v2-style">
      .sb2 * { box-sizing: border-box; font-family: system-ui, -apple-system, Segoe UI, Roboto, Inter, sans-serif; }
      .sb2 { background: rgba(0,0,0,.5); color: #eaf7f4; border: 1px solid rgba(255,255,255,.1); border-radius: 14px; padding: 16px; }
      .sb2 h3 { margin: 0 0 10px; color: #fff; }
      .sb2 .row { display: grid; gap: 10px; margin: 10px 0; }
      .sb2 input[type="text"], .sb2 textarea {
        width: 100%; padding: 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,.16);
        background: rgba(255,255,255,.06); color: #fff;
      }
      .sb2 button {
        display: inline-flex; align-items: center; justify-content: center; gap: .5rem;
        padding: .8rem 1.2rem; border-radius: 999px; font-weight: 800; border: 0; cursor: pointer;
      }
      .sb2 .btn {
        background: linear-gradient(90deg,#42ffd2,#6aa8ff); color: #031b17;
      }
      .sb2 .btn-ghost {
        background: rgba(255,255,255,.08); color: #fff; border: 1px solid rgba(255,255,255,.16);
        border-radius: 10px; padding: .6rem .9rem;
      }
      .sb2 .hints { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0 0; }
      .sb2 .hint { background: rgba(66,255,210,.16); color: #eafff7; padding: .5rem .8rem; border-radius: 999px; cursor: pointer; }
      .sb2 .list { display: grid; gap: 8px; margin-top: 10px; }
      .sb2 .opt {
        background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14);
        border-radius: 12px; padding: 12px; cursor: pointer;
      }
      .sb2 .opt.selected { border-color: #42ffd2; box-shadow: 0 0 18px rgba(66,255,210,.25); }
      .sb2 .out { margin-top: 14px; display: none; }
      .sb2 .meta { display: grid; gap: 10px; }
      .sb2 .small { opacity: .85; font-size: 12px; }
      .sb2 .log { font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace; opacity: .95; margin: 8px 0; max-height: 140px; overflow: auto; }
      .sb2 .ok { color: #42ffd2; }
      .sb2 .err { color: #ffd166; }
      .sb2 .faq details { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14); border-radius: 10px; padding: .6rem .8rem; margin: .5rem 0; }
      .sb2 .row-inline { display:flex; gap:8px; align-items:center; }
    </style>

    <div class="sb2" role="region" aria-label="SEOBoss Console v2">
      <div class="row">
        <h3>SEOBoss Console</h3>
        <div class="small">Shop: <strong>${SHOP || '(unknown)'}</strong> · Client: <strong>${CLIENT_ID || '(none)'}</strong></div>
      </div>

      <div class="row">
        <label for="sb2_kw">Keyword</label>
        <input id="sb2_kw" type="text" placeholder="Loading ideas…">
        <div class="hints" id="sb2_hints"></div>
        <div class="row-inline">
          <button id="sb2_titles_btn" class="btn">Get title ideas</button>
          <button id="sb2_reset_btn" class="btn-ghost">Reset</button>
        </div>
        <div class="log" id="sb2_log"></div>
      </div>

      <div class="row" id="sb2_titles_wrap" style="display:none">
        <h3>Suggestions</h3>
        <div class="list" id="sb2_titles"></div>
      </div>

      <div class="row" id="sb2_meta_wrap" style="display:none">
        <h3>Finalize</h3>
        <div class="meta">
          <input id="sb2_title" type="text" placeholder="Blog title">
          <input id="sb2_meta_title" type="text" maxlength="70" placeholder="Meta title (≤ 70)">
          <textarea id="sb2_meta_desc" rows="3" maxlength="160" placeholder="Meta description (≤ 160)"></textarea>
        </div>
        <label class="row-inline" style="margin-top:6px;">
          <input type="checkbox" id="sb2_publish"> Publish immediately
        </label>
        <button id="sb2_post_btn" class="btn" style="margin-top:6px;">Generate article</button>
      </div>

      <div class="out" id="sb2_out">
        <h3>Blog Output</h3>
        <div id="sb2_article"></div>
        <p id="sb2_live" class="small" style="display:none">Live URL: <a id="sb2_live_a" href="#" target="_blank" rel="noopener"></a></p>
        <div class="faq" id="sb2_faq"></div>
      </div>
    </div>
  `;
  mount.innerHTML = html;

  // ---- helpers ----
  const $ = (s) => mount.querySelector(s);
  const log = $("#sb2_log");
  const say = (t, cls = "ok") => {
    const p = document.createElement("div");
    p.className = cls;
    p.textContent = t;
    log.appendChild(p);
    log.scrollTop = log.scrollHeight;
  };

  async function fetchJSON(url, { method = "GET", body, headers = {}, signal } = {}) {
    const opts = {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Seoboss-Ts": String(Math.floor(Date.now() / 1000)),
        "X-Client-ID": CLIENT_ID || "",
        "X-Shop": SHOP || "",
        ...headers
      },
      signal
    };
    if (body) opts.body = JSON.stringify(body);

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), CFG.timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText}${txt ? ` — ${txt.slice(0,180)}` : ""}`);
      }
      const ct = res.headers.get("content-type") || "";
      return ct.includes("application/json") ? res.json() : res.text();
    } finally {
      clearTimeout(t);
    }
  }

  // ---- state ----
  const S = {
    selected: null,  // selected suggestion object
    pool: []         // suggestions list
  };

  // ---- Hints flow ----
  const kwInput = $("#sb2_kw");
  const hintsBox = $("#sb2_hints");

  async function loadHints() {
    try {
      const r = await fetchJSON(CFG.endpoints.hints, { method: "GET" });
      const hints = Array.isArray(r?.hints) && r.hints.length
        ? r.hints
        : ["blog ideas for spring", "email marketing tips", "shopify shipping guide", "gift ideas for runners"];
      kwInput.placeholder = hints[0];
      hintsBox.innerHTML = hints.map(h => `<span class="hint">${h}</span>`).join("");
      hintsBox.querySelectorAll(".hint").forEach(el => el.addEventListener("click", () => {
        kwInput.value = el.textContent;
        kwInput.focus();
      }));
      say("Hints loaded.");
    } catch (e) {
      kwInput.placeholder = "Enter your SEO keyword…";
      say("Hints unavailable (using manual keyword).", "err");
    }
  }

  // ---- Titles flow ----
  const titlesBtn   = $("#sb2_titles_btn");
  const titlesWrap  = $("#sb2_titles_wrap");
  const titlesList  = $("#sb2_titles");
  const metaWrap    = $("#sb2_meta_wrap");
  const postBtn     = $("#sb2_post_btn");
  const resetBtn    = $("#sb2_reset_btn");

  function resetAll() {
    S.selected = null;
    S.pool = [];
    titlesWrap.style.display = "none";
    metaWrap.style.display = "none";
    $("#sb2_out").style.display = "none";
    $("#sb2_article").innerHTML = "";
    $("#sb2_faq").innerHTML = "";
    $("#sb2_live").style.display = "none";
    $("#sb2_live_a").textContent = "";
    kwInput.value = "";
    $("#sb2_title").value = "";
    $("#sb2_meta_title").value = "";
    $("#sb2_meta_desc").value = "";
    $("#sb2_publish").checked = PUBLISH_DEFAULT;
    log.innerHTML = "";
    say("Console reset.");
  }
  resetBtn.addEventListener("click", resetAll);
  $("#sb2_publish").checked = PUBLISH_DEFAULT;

  titlesBtn.addEventListener("click", async () => {
    const keyword = kwInput.value.trim() || kwInput.placeholder || "";
    if (!keyword) return;
    say("Requesting title ideas…");
    try {
      const data = await fetchJSON(CFG.endpoints.titles, {
        method: "POST",
        body: {
          client_id: CLIENT_ID || undefined,
          shop: SHOP || undefined,
          input_keyword: keyword
        }
      });
      const items = Array.isArray(data?.titles) ? data.titles : [];
      if (!items.length) throw new Error("No suggestions returned.");
      S.pool = items;
      titlesList.innerHTML = items.map((t, i) => {
        const title = t.title || "Untitled";
        const mt    = t.meta_title || "";
        const md    = t.meta_description || "";
        return `<div class="opt" data-idx="${i}">
          <strong>${title}</strong><br>
          <span class="small">${mt || "— meta title —"}</span><br>
          <span class="small">${md || "— meta description —"}</span>
        </div>`;
      }).join("");

      titlesWrap.style.display = "block";
      metaWrap.style.display = "none";
      $("#sb2_out").style.display = "none";

      titlesList.querySelectorAll(".opt").forEach(el => {
        el.addEventListener("click", () => {
          titlesList.querySelectorAll(".opt").forEach(n => n.classList.remove("selected"));
          el.classList.add("selected");
          const idx = parseInt(el.dataset.idx, 10);
          S.selected = S.pool[idx] || null;
          $("#sb2_title").value      = S.selected?.title || "";
          $("#sb2_meta_title").value = S.selected?.meta_title || "";
          $("#sb2_meta_desc").value  = S.selected?.meta_description || "";
          metaWrap.style.display = "block";
          say("Suggestion selected.");
        });
      });

      say("Suggestions ready.");
    } catch (e) {
      say(`Titles error: ${e.message || e}`, "err");
    }
  });

  // ---- Post flow ----
  const outWrap   = $("#sb2_out");
  const articleEl = $("#sb2_article");
  const faqEl     = $("#sb2_faq");
  const liveP     = $("#sb2_live");
  const liveA     = $("#sb2_live_a");

  function tryJson(x){ try { return JSON.parse(x); } catch { return null; } }

  function extractFaqFromHtml(html) {
    const dom = new DOMParser().parseFromString(html || "", "text/html");
    const faqSelectors = ['[data-faq]','section.faq','section.faqs','.faq-section','#faq','#faqs','.faq-block'];
    let faqEl = null;
    for (const sel of faqSelectors) {
      const n = dom.querySelector(sel);
      if (n) { faqEl = n; break; }
    }
    const jsonScripts = dom.querySelectorAll('script[type="application/ld+json"]');
    let items = [];
    jsonScripts.forEach(s => {
      const j = tryJson(s.textContent || "");
      if (!j) return;
      const page = Array.isArray(j?.['@graph'])
        ? j['@graph'].find(g => g['@type'] === 'FAQPage')
        : (j?.['@type'] === 'FAQPage' ? j : null);
      const ents = page?.mainEntity || [];
      ents.forEach(ent => {
        const q = ent?.name || ent?.['@name'] || "";
        const a = ent?.acceptedAnswer?.text || "";
        if (q && a) items.push({ q, a });
      });
    });
    const faqHtml = faqEl ? faqEl.innerHTML : "";
    if (faqEl) faqEl.remove();
    return { articleHtml: dom.body.innerHTML, faqItems: items, faqHtml };
  }

  postBtn.addEventListener("click", async () => {
    if (!S.selected) {
      say("Pick a suggestion first.", "err");
      return;
    }
    const edited = {
      title:          $("#sb2_title").value.trim()      || S.selected.title || "",
      meta_title:     $("#sb2_meta_title").value.trim() || S.selected.meta_title || "",
      meta_description: $("#sb2_meta_desc").value.trim()|| S.selected.meta_description || ""
    };
    const publish = $("#sb2_publish").checked;

    say("Generating article…");
    try {
      const payload = {
        client_id: CLIENT_ID || undefined,
        shop: SHOP || undefined,
        title: edited.title,
        meta_title: edited.meta_title,
        meta_description: edited.meta_description,
        tags: S.selected?.tags || "",
        summary_html: S.selected?.summary_html || "",
        author: "SEOBoss",
        published: !!publish,
        metafields: { custom: { faq_json: S.selected?.faq_json || "" } },
        slug: S.selected?.slug || ""
      };

      const blog = await fetchJSON(CFG.endpoints.post, { method: "POST", body: payload });

      const html = blog?.body_html || "";
      const { articleHtml, faqItems, faqHtml } = extractFaqFromHtml(html);

      outWrap.style.display = "block";
      const safe = (window.DOMPurify ? DOMPurify.sanitize(articleHtml || html) : (articleHtml || html));
      articleEl.innerHTML = safe || "<p>No blog content returned.</p>";

      // live url (if provided)
      const liveUrl = blog?.url || blog?.link || blog?.permalink || blog?.post?.url || "";
      if (liveUrl) {
        liveA.href = liveUrl;
        liveA.textContent = liveUrl;
        liveP.style.display = "block";
      } else {
        liveP.style.display = "none";
      }

      // FAQ rendering
      faqEl.innerHTML = "";
      const items = Array.isArray(blog?.faq_json) ? blog.faq_json
                  : (typeof blog?.faq_json === "string" ? tryJson(blog.faq_json) : null)
                  || (faqItems && faqItems.length ? faqItems : null);

      if (items && items.length) {
        faqEl.innerHTML = items.map((it, idx) =>
          `<details ${idx===0 ? "open" : ""}><summary>${it.q || it.question}</summary><div class="answer">${it.a || it.answer || ""}</div></details>`
        ).join("");
      } else if (faqHtml) {
        faqEl.innerHTML = (window.DOMPurify ? DOMPurify.sanitize(faqHtml) : faqHtml);
      }

      say("Article generated.");
    } catch (e) {
      say(`Post error: ${e.message || e}`, "err");
    }
  });

  // ---- third-party sanitizer (optional) ----
  (function ensureDomPurify(){
    if (window.DOMPurify) return;
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js";
    s.defer = true;
    document.head.appendChild(s);
  })();

  // ---- go ----
  loadHints().then(() => say("Ready."));
})();
