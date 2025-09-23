// SEOBoss Engine Core – Console only
(() => {
  const CFG = window.SEO_BOSS_CONFIG || {
    endpoints: { hints:"/apps/engine/hints", titles:"/apps/engine/blog-titles", post:"/apps/engine/blog-post", alive:"/apps/engine/_alive" },
    version: "widget-fallback"
  };

  // Add DOMPurify if missing (for safe HTML)
  if (!window.DOMPurify) {
    const s = document.createElement('script');
    s.src = "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js";
    document.head.appendChild(s);
  }

  const host = document.getElementById('seoboss-console');
  if (!host) return;

  // ---------- UI MARKUP (console only) ----------
  host.innerHTML = `
    <div class="wrap seoboss-shell">
      <div class="agent-header">
        <div class="agent-status"><span class="status-dot"></span> Agent Online</div>
        <h2>SEOBoss Agent Console</h2>
        <p>Generate a Shopify-ready blog draft in under a minute.</p>
        <div class="agent-tools">
          <button id="stopBtn" class="btn btn-sm" type="button" disabled>⛔ Stop</button>
          <button id="resetBtn" class="btn btn-sm" type="button">🔁 Reset</button>
        </div>
        <div class="health-badge" style="display:none" id="sb-health">✅ Secure Connection</div>
      </div>

      <form id="keywordForm" class="agent-form" novalidate>
        <label for="keywordInput">&gt; Enter keyword or choose below:</label>
        <input id="keywordInput" type="text" placeholder="Loading hint from Hint Agent…" required>
        <button id="deployBtn" type="submit" class="btn btn-block btn-gradient">🚀 Deploy Agent</button>
      </form>

      <div class="hint-status">💡 Hint Agent: pick a hint below or type your own.</div>
      <div id="hintContainer" class="hint-container"></div>

      <div class="log-header">
        <div class="scanner"></div>
        <span>Agent Telemetry</span>
      </div>
      <div id="agentLogs" class="agent-logs" role="status" aria-live="polite" aria-busy="false"><p>Awaiting command…</p></div>
      <div class="progress" aria-hidden="true"><i id="progressFill" style="width:0%"></i></div>

      <div id="titlesSection" class="agent-section" style="display:none;">
        <h3>📌 Agent Suggestions</h3>
        <div id="skeletons" class="skeletons" aria-hidden="true" style="display:none"></div>
        <div id="titlesContainer"></div>
      </div>

      <div id="finalStep" class="agent-section" style="display:none;">
        <h3>✅ Step 2: Finalize Your Blog</h3>
        <div class="meta-grid">
          <div class="meta-card">
            <label for="finalTitle">Blog Title</label>
            <input id="finalTitle" type="text" placeholder="Edit your blog title here…">
            <button type="button" class="btn btn-sm copy-btn" data-copy="#finalTitle">Copy</button>
          </div>
          <div class="meta-card">
            <label for="metaTitleInput">Meta Title</label>
            <input id="metaTitleInput" type="text" maxlength="70" placeholder="Edit meta title…">
            <small><span id="metaTitleCount">0</span>/70</small>
            <button type="button" class="btn btn-sm copy-btn" data-copy="#metaTitleInput">Copy</button>
          </div>
          <div class="meta-card">
            <label for="metaDescriptionInput">Meta Description</label>
            <textarea id="metaDescriptionInput" rows="3" maxlength="160" placeholder="Edit meta description…"></textarea>
            <small><span id="metaDescCount">0</span>/160</small>
            <button type="button" class="btn btn-sm copy-btn" data-copy="#metaDescriptionInput">Copy</button>
          </div>
        </div>
        <div class="toggles">
          <label class="toggle"><input id="publishToggle" type="checkbox"> Publish immediately</label>
        </div>
        <form id="finalForm" class="agent-form" novalidate aria-controls="outputConsole faqConsole">
          <div class="row-actions">
            <button id="generateBtn" type="submit" class="btn btn-gradient">📝 Generate Article</button>
          </div>
        </form>
        <div class="hint-status">✏️ You can edit title & meta before generating. Choose draft or publish.</div>
      </div>

      <div id="outputConsole" class="agent-output" style="display:none;">
        <h3>📝 Blog Agent Output</h3>
        <div id="blogContent" aria-live="polite"></div>
        <div id="successMessage" style="display:none; margin-top:1rem; color:var(--brand-accent); font-weight:bold;">
          ✅ Success! Your article is live: <a id="articleUrl" href="#" target="_blank" rel="noopener">View Article</a>
        </div>
        <div id="successShelf" class="after-output" style="margin-top:.6rem;"></div>
      </div>

      <div id="faqConsole" class="agent-output" style="display:none;">
        <h3>❓ FAQ Agent Output</h3>
        <div id="faqContent"></div>
      </div>

      <canvas id="confettiCanvas" class="confetti" width="0" height="0" aria-hidden="true"></canvas>
    </div>
  `;

  // ---------- Your existing JS (trimmed to console) ----------
  const $=(s)=>document.querySelector(s);
  const logs=$('#agentLogs'), titlesSection=$('#titlesSection'), titlesContainer=$('#titlesContainer'),
        outputConsole=$('#outputConsole'), faqConsole=$('#faqConsole'), finalStep=$('#finalStep'),
        finalTitle=$('#finalTitle'), metaTitleInput=$('#metaTitleInput'), metaDescriptionInput=$('#metaDescriptionInput'),
        metaTitleCount=$('#metaTitleCount'), metaDescCount=$('#metaDescCount'),
        deployBtn=$('#deployBtn'), generateBtn=$('#generateBtn'),
        progressFill=$('#progressFill'), stopBtn=$('#stopBtn'), resetBtn=$('#resetBtn'),
        confettiCanvas=$('#confettiCanvas'), publishToggle=$('#publishToggle');

  const state = { runningTitles:false, runningArticle:false };
  let fetchCtrl=null, __COUNTERS_BOUND=false, hintIntervalId=null;

  const delay=(ms)=>new Promise(r=>setTimeout(r,ms));
  function gateSubmit(){ const now=Date.now(); if(!gateSubmit._t) gateSubmit._t=0; if(now - gateSubmit._t < 900) return false; gateSubmit._t=now; return true; }
  function smoothScrollTo(el, duration=3200, offset=-80){
    if(!el) return; const startY = window.pageYOffset; const targetY = el.getBoundingClientRect().top + startY + offset;
    const distance = targetY - startY; let start=null; function step(ts){ if(!start) start=ts;
      const t=Math.min((ts-start)/duration,1); const ease=t<.5?2*t*t:-1+(4-2*t)*t; window.scrollTo(0,startY+distance*ease); if(t<1) requestAnimationFrame(step); }
    requestAnimationFrame(step);
  }

  // Health badge
  (async ()=>{
    try { const r = await fetch(CFG.endpoints.alive); if (r.ok) $('#sb-health').style.display='block'; } catch {}
  })();

  function readClient(){ try{ return JSON.parse(localStorage.getItem('seoboss:client')||'{}'); }catch{return {}; } }
  function addAuth(payload){ const c=readClient()||{}; return { client_id:(c.id||''), default_blog_id:(c.default_blog_id||''), ...payload }; }

  const META_STORE = new Map(); let META_COUNTER = 0;

  const Logger = (()=>{ let aborted=false; function cancel(){aborted=true;} async function typeLine(text,speed=20){
      const p=document.createElement('p'); logs.appendChild(p);
      for(let i=0;i<text.length;i++){ if(aborted) return; p.textContent+=text.charAt(i); if(i%2===0) logs.scrollTop=logs.scrollHeight; await delay(speed); }
    }
    async function run(lines,totalMs){ const started=Date.now(); const timer=setInterval(()=>{
        const pct=Math.min(100,((Date.now()-started)/totalMs)*100); progressFill.style.width=pct.toFixed(1)+'%';
      },120);
      for(const line of lines){ if(aborted) break; await typeLine(line); await delay(180); }
      clearInterval(timer); progressFill.style.width='100%';
    }
    function reset(){ aborted=false; logs.innerHTML=''; } return { run, cancel, reset, typeLine };
  })();
  function startProgress(){ progressFill.style.width='0%' } function endProgress(){ progressFill.style.width='100%' }

  const LOGS = {
    titles: ["▶ Deploying Title Intelligence Agent…","✓ Uplink secured. Systems online.","→ Scanning live search lattice for patterns…",
             "→ Researching keyword maps…","↺ Noise filtering. Priority ranks recalculated.","☑ Keywords filtered. Signal clean.",
             "✓ Title module active.","→ Decoding resonance fields in buyer intent…","↺ Metadata analysis initiated.",
             "→ Testing SERP angle projections…","☑ Rich results signals received.","↺ Variation engine drafting 5 title options…",
             "☑ Meta variation set generated.","↺ Optimization agent engaged.","→ CTR optimizer running simulations…",
             "↺ Variation engine re-engaged.","☑ Shortlist finalized.","↺ Engines cooling..","→ Results rendering…",
             "✓ Transmission complete: — ETA ~5s…"],
    article:["▶ Launching Research Agent…","✓ Intent locked. Knowledge modules online.","→ Narrative scaffold forming…","↺ Keyword data gathered.",
             "→ Semantic bridges connecting clusters…","✓ Writing agent engaged.","→ Persuasive lead-ins generated.","☑ Keyword harmonics balanced.",
             "↺ Engagement trajectory mapped.","☑ Article layout structured.","↺ Scanning existing posts for matches…","→ Identifying internal link positions…",
             "→ Creating contextual links to posts…","▶ Schema agent activated.","→ FAQ researcher distilling live queries…",
             "→ Schema builder weaving JSON-LD…","→ LLM snippet agent carving featured answers…","→ SEO optimizer refining HTML wrappers…",
             "☑ Front-end FAQ HTML generated.","☑ H1/H2 positioning finalized.","☑ Compliance check passed.","☑ Schema payload validated.",
             "↺ Final container rendering…","↺ Handshake queued ","✓ Mission complete: Article deployed — ETA ~15s…"]
  };

  function fireConfetti(){ const host=host||document.querySelector('.seoboss-shell'); const r=host.getBoundingClientRect();
    const dpr=Math.max(1,Math.floor(window.devicePixelRatio||1)); const cv=confettiCanvas; cv.width=Math.floor(r.width*dpr); cv.height=Math.floor(r.height*dpr);
    cv.style.width=r.width+'px'; cv.style.height=r.height+'px'; const ctx=cv.getContext('2d'); ctx.scale(dpr,dpr);
    const colors=['var(--brand-primary)','var(--brand-secondary)','#ffd166','#9af7df','#b5c6ff'];
    const parts=Array.from({length:60}).map(()=>({x:Math.random()*r.width,y:-10-Math.random()*40,vy:2+Math.random()*3,vx:-1+Math.random()*2,sz:3+Math.random()*5,rot:Math.random()*Math.PI,vr:(-0.2+Math.random()*0.4),c:colors[Math.floor(Math.random()*colors.length)]}));
    const start=performance.now(); (function frame(t){ const dt=t-start; const w=r.width,h=r.height; ctx.clearRect(0,0,w,h);
      parts.forEach(p=>{ p.x+=p.vx; p.y+=p.vy; p.rot+=p.vr; ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot); ctx.fillStyle=p.c; ctx.fillRect(-p.sz/2,-p.sz/2,p.sz,p.sz); ctx.restore(); });
      if(dt<1100) requestAnimationFrame(frame); else ctx.clearRect(0,0,w,h);
    })();
  }

  async function fetchJSON(url, {body, signal, method='POST', headers={}} = {}, tries=2) {
    const res = await fetch(url, { method, headers:{'Content-Type':'application/json','X-SeoBoss-Version':CFG.version,...headers}, body: body?JSON.stringify(body):undefined, signal });
    if (!res.ok) {
      const text = await res.text().catch(()=> ''); const why =
        res.status === 401 ? "Signature/Proxy failed (check SHOPIFY_APP_SECRET & App Proxy)"
      : res.status === 403 ? "Forward secret mismatch (FORWARD_SECRET Netlify vs n8n)"
      : res.status === 404 ? "Endpoint path/method mismatch in n8n"
      : res.status >= 500 ? "Upstream error (n8n/worker)" : `HTTP ${res.status} — ${res.statusText}`;
      const msg = `${why}${text ? `: ${text.slice(0,180)}` : ''}`;
      if (tries > 0 && res.status >= 500) { await delay(300 + Math.random()*500); return fetchJSON(url,{body,signal,method,headers},tries-1); }
      throw new Error(msg);
    }
    return res.json();
  }

  function tryJson(x){ try{ return JSON.parse(x); }catch{return null;} }
  function extractFaqFromHtml(html){
    const dom=new DOMParser().parseFromString(html,'text/html');
    const faqSelectors=['[data-faq]','section.faq','section.faqs','.faq-section','#faq','#faqs','.faq-block'];
    let faqEl=null; for(const sel of faqSelectors){ const n=dom.querySelector(sel); if(n){ faqEl=n; break; } }
    let faqItems=[]; dom.querySelectorAll('script[type="application/ld+json"]').forEach(s=>{
      const j=tryJson(s.textContent||''); if(j && (j['@type']==='FAQPage' || (Array.isArray(j['@graph']) && j['@graph'].some(g=>g['@type']==='FAQPage')))){
        const page = j['@type']==='FAQPage' ? j : (j['@graph']||[]).find(g=>g['@type']==='FAQPage');
        (page?.mainEntity||[]).forEach(ent=>{ const q=ent.name||ent['@name']||''; const a=(ent.acceptedAnswer?.text)||''; if(q && a) faqItems.push({q,a}); });
      }
    });
    let faqHtml=''; if(faqEl){ faqHtml=faqEl.innerHTML; faqEl.remove(); }
    return { articleHtml: dom.body.innerHTML, faqItems, faqHtml };
  }
  function extractFaqFromResponse(blog){
    let items=[]; const directJson = blog.faq_json || blog.faq || (blog.metafields && blog.metafields.custom && blog.metafields.custom.faq_json);
    if(typeof directJson === 'string'){ const arr=tryJson(directJson); if(Array.isArray(arr)) items = arr.map(x=>({q:x.question||x.q||'', a:x.answer||x.a||''})).filter(x=>x.q && x.a); }
    if(Array.isArray(directJson)) items = directJson.map(x=>({q:x.question||x.q||'', a:x.answer||x.a||''})).filter(x=>x.q && x.a);
    const { articleHtml, faqItems, faqHtml } = extractFaqFromHtml(blog.body_html||''); if(!items.length && faqItems.length) items=faqItems;
    return { articleHtml, faqItems: items, faqHtml };
  }
  function renderFaq({faqItems, faqHtml}){
    const box = document.getElementById('faqContent'); if(!faqItems.length && !faqHtml){ faqConsole.style.display='none'; return; }
    faqConsole.style.display='block';
    if(faqItems.length){
      const inner = faqItems.map((it,idx)=>`<details ${idx===0?'open':''}><summary>${it.q}</summary><div class="answer">${(window.DOMPurify? DOMPurify.sanitize(it.a): it.a)}</div></details>`).join('');
      box.innerHTML = `<div class="faq-accordion">${inner}</div>`;
    } else { box.innerHTML = (window.DOMPurify? DOMPurify.sanitize(faqHtml): faqHtml); }
  }

  function bindCounters(){
    if(__COUNTERS_BOUND) return; __COUNTERS_BOUND = true;
    const upd=()=>{
      metaTitleCount.textContent = String(metaTitleInput.value.length);
      metaDescCount.textContent  = String(metaDescriptionInput.value.length);
      localStorage.setItem('seoboss:last_meta', JSON.stringify({
        title: finalTitle.value || '', meta_title: metaTitleInput.value || '', meta_description: metaDescriptionInput.value || ''
      }));
    };
    metaTitleInput.addEventListener('input', upd); metaDescriptionInput.addEventListener('input', upd); finalTitle.addEventListener('input', upd); upd();
  }
  function restoreLastMeta(){ try{
    const j = JSON.parse(localStorage.getItem('seoboss:last_meta')||'{}');
    if(j.title || j.meta_title || j.meta_description){ finalTitle.value=j.title||finalTitle.value; metaTitleInput.value=j.meta_title||metaTitleInput.value; metaDescriptionInput.value=j.meta_description||metaDescriptionInput.value; }
  }catch{} }

  function showSkeletons(n=6){ const box=$('#skeletons'); box.style.display='grid'; box.innerHTML=Array.from({length:n}).map(()=>'<div class="skeleton"></div>').join(''); }
  function hideSkeletons(){ const box=$('#skeletons'); box.style.display='none'; box.innerHTML=''; }

  function resetAll(){
    Logger.cancel(); fetchCtrl?.abort(); logs.innerHTML='<p>Awaiting command…</p>'; startProgress(); endProgress();
    titlesSection.style.display='none'; titlesContainer.innerHTML=''; hideSkeletons();
    finalStep.style.display='none'; outputConsole.style.display='none'; faqConsole.style.display='none';
    stopBtn.disabled=true; deployBtn.disabled=false; generateBtn.disabled=false; state.runningTitles=false; state.runningArticle=false;
    if(hintIntervalId){ clearInterval(hintIntervalId); hintIntervalId=null; }
  }
  function stopNow(){ Logger.cancel(); fetchCtrl?.abort(); stopBtn.disabled=true; logs.appendChild(Object.assign(document.createElement('p'),{textContent:'⏹️ Stopped by user.'})); }
  resetBtn.addEventListener('click', resetAll); stopBtn.addEventListener('click', stopNow);

  // STEP 1: titles
  $('#keywordForm').addEventListener('submit', async (e)=>{
    e.preventDefault(); if(state.runningTitles || !gateSubmit()) return;
    const input=$('#keywordInput'); const keyword=input.value.trim(); if(!keyword){ input.focus(); return; }
    state.runningTitles = true;

    logs.innerHTML=""; startProgress(); logs.setAttribute('aria-busy','true');
    await Logger.typeLine('Receiving command…'); stopBtn.disabled=false; deployBtn.disabled=true; const idle=deployBtn.textContent; deployBtn.textContent='⏳ Finding angles…'; showSkeletons();

    try{
      fetchCtrl = new AbortController();
      const logsTask = Logger.run(LOGS.titles, 13000);
      const fetchPromise = fetchJSON(CFG.endpoints.titles, { body: addAuth({ input_keyword: keyword }), signal: fetchCtrl.signal, headers: {'X-Client-ID': (readClient().id||'')} });
      const data=await Promise.race([fetchPromise, new Promise((_,rej)=>setTimeout(()=>rej(new Error('Request timed out')), 120000))]);

      await logsTask.catch(()=>{});
      const titles=data.titles||[]; if(!titles.length) throw new Error('No suggestions returned.');

      const html = titles.map((t)=>{
        const meta = { title:t.title||"Untitled", meta_title:t.meta_title||"", meta_description:t.meta_description||"", summary_html:t.summary_html||"", faq_json:t.faq_json||"", slug:t.slug||"", tags:t.tags||"", keywords:t.keywords||[], category:t.category||"" };
        const key = `k${++META_COUNTER}`; META_STORE.set(key, meta);
        return `<div class="title-option" tabindex="0" role="button" data-key="${key}"><strong>${meta.title}</strong><div class="micro"><em>${meta.meta_title || '— meta title —'}</em><br><span>${meta.meta_description || '— meta description —'}</span></div></div>`;
      }).join("");

      titlesSection.style.display="block"; hideSkeletons();
      const wrap = document.createElement('div'); wrap.innerHTML = html; titlesContainer.innerHTML = ''; titlesContainer.appendChild(wrap);

      titlesContainer.querySelectorAll('.title-option').forEach(el=>{
        const select=()=>{
          titlesContainer.querySelectorAll('.title-option').forEach(n=>n.classList.remove('selected'));
          el.classList.add('selected'); const meta = META_STORE.get(el.dataset.key) || {};
          finalTitle.value = meta.title||''; metaTitleInput.value = meta.meta_title||''; metaDescriptionInput.value = meta.meta_description||'';
          bindCounters(); finalStep.style.display='block'; titlesContainer.dataset.selectedKey = el.dataset.key; finalTitle.focus(); smoothScrollTo(finalStep);
        };
        el.addEventListener('click',select); el.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); select(); }});
      });

    }catch(err){
      Logger.cancel(); logs.appendChild(Object.assign(document.createElement('p'),{textContent:'Error: '+(err?.message||'Unknown')})); logs.appendChild(Object.assign(document.createElement('p'),{textContent:'Tip: endpoint may be sleeping. Try again.'}));
    }finally{
      deployBtn.disabled=false; deployBtn.textContent=idle; stopBtn.disabled=true; endProgress(); logs.setAttribute('aria-busy','false'); state.runningTitles=false; hideSkeletons();
    }
  });

  // STEP 2: article
  $('#finalForm').addEventListener('submit', async (e)=>{
    e.preventDefault(); if(state.runningArticle || !gateSubmit()) return;
    if(!titlesContainer.dataset.selectedKey){ logs.appendChild(Object.assign(document.createElement('p'),{textContent:'Select a headline first.'})); smoothScrollTo(logs); return; }
    state.runningArticle = true;

    logs.innerHTML=""; startProgress(); await Logger.typeLine('Deploying Blog Agent…'); stopBtn.disabled=false;
    const idle=generateBtn.textContent; generateBtn.disabled=true; generateBtn.textContent='⏳ Writing article…';

    try{
      const meta = META_STORE.get(titlesContainer.dataset.selectedKey) || {};
      const edited = { title:(finalTitle.value.trim()||meta.title), meta_title:(metaTitleInput.value||meta.meta_title||''), meta_description:(metaDescriptionInput.value||meta.meta_description||'') };
      fetchCtrl = new AbortController();
      const payload = addAuth({ title:edited.title, meta_title:edited.meta_title, meta_description:edited.meta_description, tags:meta.tags||"", summary_html:meta.summary_html||"", author:"SEOBoss", published:!!publishToggle.checked, metafields:{ custom:{ faq_json:meta.faq_json||"" } }, slug: meta.slug||"" });

      const logsTask = Logger.run(LOGS.article, 25000);
      const fetchPromise = fetchJSON(CFG.endpoints.post, { body: payload, signal: fetchCtrl.signal, headers: {'X-Client-ID': (readClient().id||'')} });
      const blog=await Promise.race([fetchPromise, new Promise((_,rej)=>setTimeout(()=>rej(new Error('Request timed out')), 120000))]);

      await logsTask.catch(()=>{});
      const { articleHtml, faqItems, faqHtml } = extractFaqFromResponse(blog);

      outputConsole.style.display="block";
      const html = articleHtml || blog.body_html || '<p>No blog content returned.</p>';
      const safe = (window.DOMPurify? DOMPurify.sanitize(html) : html);

      const wrap = document.createElement('div');
      wrap.innerHTML = `<div style="background:var(--brand-bg3);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:1.2rem;color:#eaf7f4;max-width:68ch;line-height:1.7;word-break:break-word">${safe}</div>`;
      const target = document.getElementById('blogContent'); target.innerHTML = ''; target.appendChild(wrap);

      const liveUrl = blog.url || blog.link || blog.permalink || (blog.post && blog.post.url) || '';
      if(liveUrl){ const sm = document.getElementById('successMessage'); const au = document.getElementById('articleUrl'); sm.style.display='block'; au.href = liveUrl; au.textContent = liveUrl; }

      renderFaq({ faqItems, faqHtml });
      logs.appendChild(Object.assign(document.createElement('p'),{textContent:'Article payload rendered.'}));
      setTimeout(()=>smoothScrollTo(document.getElementById('blogContent')), 200); setTimeout(()=>fireConfetti(), 120);

    }catch(err){
      Logger.cancel(); logs.appendChild(Object.assign(document.createElement('p'),{textContent:'Error: '+(err?.message||'Unknown')})); logs.appendChild(Object.assign(document.createElement('p'),{textContent:'Tip: endpoint may be sleeping. Try again.'}));
    }finally{
      generateBtn.disabled=false; generateBtn.textContent=idle; stopBtn.disabled=true; endProgress(); state.runningArticle=false;
    }
  });

  // ---- Hints (neutral fallback + flag) ----
const HINTS = {
  fallback: [
    "how to choose a blog topic",
    "product comparison: X vs Y",
    "beginner’s guide to [your niche]",
    "common mistakes with [product]",
    "how to use [product] for [goal]",
    "seasonal ideas for [audience]",
  ],
  rotateMs: 4000,
};

const FEATURE_FLAGS = { hintsEnabled: true };

async function initHints(){
  const input = $('#keywordInput'), hintBox = $('#hintContainer');

  if (!FEATURE_FLAGS.hintsEnabled){
    hintBox.innerHTML = "";
    input.setAttribute('placeholder','Enter a keyword…');
    return;
  }

  let hints = [];
  try {
    const r = await Promise.race([
      fetch(CONFIG.endpoints.hints, { method: 'GET' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), CONFIG.timeoutMs))
    ]);
    const d = await r.json().catch(() => ({}));
    hints = Array.isArray(d) ? d : (Array.isArray(d.hints) ? d.hints : []);
  } catch {}

  if (!hints.length) hints = HINTS.fallback;

  hintBox.innerHTML = hints
    .slice(0, 12)
    .map(h => `<div class="hint-option">${window.DOMPurify ? DOMPurify.sanitize(h) : h}</div>`)
    .join('');

  hintBox.querySelectorAll('.hint-option').forEach(el =>
    el.addEventListener('click', () => { input.value = el.textContent; input.focus(); })
  );

  // rotate placeholder; reuse your global hintIntervalId so reset() can clear it
  let i = 0;
  const start = () => {
    if (hintIntervalId) return;
    input.setAttribute('placeholder', hints[0]);
    hintIntervalId = setInterval(() => {
      input.setAttribute('placeholder', hints[i % hints.length]);
      i++;
    }, HINTS.rotateMs);
  };
  const stop = () => { if (hintIntervalId) { clearInterval(hintIntervalId); hintIntervalId = null; } };

  input.addEventListener('focus', stop);
  input.addEventListener('blur', start);
  start();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHints, { once: true });
} else {
  initHints();
}


  // copy buttons
  document.addEventListener('click', (e)=>{
    const btn = e.target.closest('.copy-btn'); if(!btn) return;
    const sel = btn.getAttribute('data-copy'); const node = document.querySelector(sel);
    if(node){ const val = (node.tagName==='TEXTAREA'||node.tagName==='INPUT') ? node.value : node.textContent;
      navigator.clipboard.writeText(val||'').then(()=>{ btn.textContent='Copied!'; setTimeout(()=>btn.textContent='Copy',1200); });
    }
  });

  // init
  (function init(){ bindCounters(); restoreLastMeta(); })();
})();
