// netlify/functions/engine-proxy.mjs
import crypto from "node:crypto";
import { errlog } from './_lib/_errlog.mjs';  // ✅ ADD THIS

// Put near the top, after imports
const ASSET_MAP = {
  "seoboss-engine.js":
    "https://cdn.shopify.com/extensions/019a36ae-dbc4-7a9f-9592-6a7a28009252/seoboss-cli-244/assets/seoboss-engine.js",
  "seoboss-engine.css":
    "https://cdn.shopify.com/extensions/019a36ae-dbc4-7a9f-9592-6a7a28009252/seoboss-cli-244/assets/seoboss-engine.css",
};


const ORIGIN = "*"; // CORS for n8n-forwarded routes

function json(status, data) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ORIGIN,
      "Access-Control-Expose-Headers": "Content-Type",
    },
    body: JSON.stringify(data),
  };
}

function getSuffix(url) {
  let p = url.pathname;
  // Strip any wrapper prefixes so routing works uniformly
  p = p.replace(/^\/\.netlify\/functions\/engine-proxy/, "");
  p = p.replace(/^\/proxy/, "");
  p = p.replace(/^\/apps\/engine/, ""); // ← handle Shopify App Proxy path
  return p || "/";
}


// Build message per Shopify App Proxy rule (exclude signature, sort keys, join dupes)
function makeProxyMessage(url) {
  const map = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (k === "signature") continue;
    (map[k] ||= []).push(v);
  }
  return Object.keys(map)
    .sort()
    .map((k) => `${k}=${map[k].join(",")}`)
    .join("");
}

function verifyWithSecret(url, secret) {
  if (!secret) return false;
  const message = makeProxyMessage(url);
  const digest = crypto.createHmac("sha256", secret).update(message, "utf8").digest("hex");
  const sig = url.searchParams.get("signature") || "";
  try {
    return (
      sig.length === digest.length &&
      crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(sig, "hex"))
    );
  } catch {
    return false;
  }
}

export const handler = async (event) => {
  // ✅ ADD THIS - Extract request_id early
  const request_id = event.headers?.["x-request-id"] || event.headers?.["X-Request-Id"] || '';
  
  const url = new URL(event.rawUrl);
  const suffix = getSuffix(url);
  const shop = url.searchParams.get("shop") || "";

  // 0) health check
  if (suffix === "/_alive") {
    return json(200, { ok: true, service: "engine-proxy", t: Date.now() });
  }

  // 1) verify App Proxy signature (support public/private app secrets)
  const secrets = [
    process.env.SHOPIFY_APP_SECRET || "",
    process.env.SHOPIFY_APP_SECRET_PUBLIC || "",
  ];
  const ok = secrets.some((s) => verifyWithSecret(url, s));
  if (!ok) return json(401, { error: "bad signature" });
  // 1.5) /apps/seoboss/console → return an HTML shell that mounts your widget


    // ── Admin/Storefront Console UI (served via App Proxy) ──────────────────────
 if (suffix === "/console") {
  const shop = (url.searchParams.get("shop") || "").toLowerCase();
  const clientId = (url.searchParams.get("client_id") || "").trim();

  const html = `<!doctype html>
<html lang="en">
<head>
  ...
  <!-- App Bridge UMD for embedded resize -->
  <script src="https://unpkg.com/@shopify/app-bridge@3.7.10/umd/index.js"></script>
</head>
<body>
  <div id="seoboss-console" data-client-id="${clientId}" data-shop="${shop}"></div>
  <script async src="/apps/engine/widget.js"></script>

  <script>
  (function(){
    try {
      const host = new URLSearchParams(location.search).get('host') || '';
      const AB = window.appBridge;
      if (!AB || !AB.createApp || !host) return;

      const app = AB.createApp({ apiKey: '5654f5c575452aefdca2592d2a2d1f3d', host, forceRedirect: true });
      const { actions } = AB;
     const fullscreen = actions.Fullscreen.create(app);
    fullscreen.dispatch(actions.Fullscreen.Action.ENTER);

    // keep your resizer too (it complements fullscreen on long pages)
    const size = actions.Size.create(app);
    const sync = () => size.dispatch(actions.Size.Action.RESIZE, {
      height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 720)
    });
    window.addEventListener('load', sync);
    new ResizeObserver(sync).observe(document.body);
    document.addEventListener('SEOBOSS:content-changed', sync);
  } catch(e) { console.warn('[SEOBoss] fullscreen/resize skipped:', e); }
})();
</script>
</body>
</html>`;
  return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, body: html };
}

// ── Tiny loader: /apps/engine/widget.js → injects engine CSS/JS ─────────────
if (suffix === "/widget.js") {
  const js = String.raw`(function(){
    if (window.__SEOBOSS_WIDGET__) return; window.__SEOBOSS_WIDGET__ = true;

    var host = document.getElementById('seoboss-console');
    if (!host) { console.warn('[SEOBoss] host not found'); return; }

    // ensure mount point for your engine
    if (!document.getElementById('seoboss-root')) {
      var root = document.createElement('div');
      root.id = 'seoboss-root';
      host.appendChild(root);
    }

    // --- Persist tenant to BOTH legacy and per-shop keys ---
    var cid  = host.getAttribute('data-client-id') || '';
    var shop = (host.getAttribute('data-shop') || '').toLowerCase();
    try {
      var prev = {};
      try { prev = JSON.parse(localStorage.getItem('seoboss:client') || '{}'); } catch(_){}
      var merged = Object.assign({}, prev, { id: cid, shop_url: shop });

      // legacy
      localStorage.setItem('seoboss:client', JSON.stringify(merged));
      // per-shop (what the onboarding page reads)
      var nsKey = shop ? ('seoboss:client:' + shop) : 'seoboss:client:__unknown__';
      if (!/__unknown__$/.test(nsKey)) localStorage.setItem(nsKey, JSON.stringify(merged));
    } catch(e){}

    // --- Endpoints via App Proxy with client_id & shop in QS ---
    window.CONFIG = window.CONFIG || {};
    (function(){
      var q = '?client_id=' + encodeURIComponent(cid) + (shop ? ('&shop=' + encodeURIComponent(shop)) : '');
      window.CONFIG.endpoints = window.CONFIG.endpoints || {
        hints:        "/apps/engine/hints"        + q,
        titles:       "/apps/engine/blog-titles"  + q,
        post:         "/apps/engine/blog-post"    + q,
        alive:        "/apps/engine/_alive"       + q,
        // Optional: direct vault endpoints if your engine calls them
        vaultList:    "/apps/engine/v3/vault/list"    + q,
        vaultAdd:     "/apps/engine/v3/vault/add"     + q,
        vaultUpdate:  "/apps/engine/v3/vault/update"  + q,
        vaultDelete:  "/apps/engine/v3/vault/delete"  + q
      };
    })();

    // load CSS from our asset passthrough
    var css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = "/apps/engine/assets/seoboss-engine.css";
    document.head.appendChild(css);

    // then load the engine JS (non-module; your bundle bootstraps itself)
    var scr = document.createElement('script');
    scr.src = "/apps/engine/assets/seoboss-engine.js";
    scr.defer = true;
    document.head.appendChild(scr);

    // --- Height sync for parents embedding this console (e.g., onboarding iframe) ---
    function postHeight(){
      try{
        var h = document.documentElement.scrollHeight || document.body.scrollHeight || 0;
        if (h) parent.postMessage({ type: 'seoboss:height', height: h }, '*');
      }catch(e){}
    }
    try{
      var ro = new ResizeObserver(postHeight);
      ro.observe(document.documentElement);
    }catch(e){
      setInterval(postHeight, 800);
    }
    window.addEventListener('load', postHeight);
  })();`;

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=60, s-maxage=60"
    },
    body: js
  };
}

  // ────────────────────────────────────────────────────────────────────────────

  /* ─────────────────────────────────────────────────────────────
     VAULT INTERCEPTOR (failsafe):
     /v3/vault/* → forward internally to Netlify functions
     Adds X-SEOBOSS-FORWARD-SECRET and passes shop/client headers.
     Works whether Shopify forwards via /proxy or root.
     ───────────────────────────────────────────────────────────── */
  const forwardToFunction = async (fnName) => {
    const qs = new URLSearchParams(url.searchParams); // keep shop, logged_in_customer_id, etc.

    // Build target to the local function
    const host = event.headers["x-forwarded-host"] || event.headers.host;
    const scheme = event.headers["x-forwarded-proto"] || "https";
    const target = `${scheme}://${host}/.netlify/functions/${fnName}${qs.size ? `?${qs}` : ""}`;

    const method = event.httpMethod || "GET";
    const needsBody = ["POST", "PUT", "PATCH"].includes(method);
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : (event.body || "");

    // Pull tenant hints from query (and pass through as headers, too)
    const shopFromQs = url.searchParams.get("shop") || "";
    const clientIdFromQs = url.searchParams.get("client_id") || "";

    try {
      const resp = await fetch(target, {
        method,
        headers: {
          "Content-Type":
            event.headers?.["content-type"] ||
            event.headers?.["Content-Type"] ||
            "application/json",
          // server-side trust: let vault-* functions auth via forward-secret
          "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || "",
          // ✅ ADD THIS - Forward correlation ID
          "X-Request-Id": request_id,
          // also pass tenant hints as headers (tenantFrom() reads these)
          "x-shop": shopFromQs || event.headers["x-shop"] || "",
          "x-client-id": clientIdFromQs || event.headers["x-client-id"] || "",
        },
        body: needsBody ? rawBody : undefined,
      });

      // ✅ ADD THIS - Log if Netlify function fails
      if (!resp.ok && resp.status >= 500) {
        const errorText = await resp.clone().text();
        await errlog({
          shop: shopFromQs,
          route: `/engine-proxy → ${fnName}`,
          status: resp.status,
          message: `Netlify function ${fnName} failed`,
          detail: errorText.slice(0, 500),
          request_id,
          code: 'E_DOWNSTREAM'
        });
      }

      const text = await resp.text();
      return {
        statusCode: resp.status,
        headers: {
          "Content-Type": resp.headers.get("content-type") || "application/json",
          // match vault functions' permissive CORS (Shopify App Proxy will consume it)
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "Content-Type",
        },
        body: text,
      };
    } catch (err) {
      // ✅ ADD THIS - Log fetch failures
      await errlog({
        shop: shopFromQs,
        route: `/engine-proxy → ${fnName}`,
        status: 500,
        message: `Failed to reach Netlify function ${fnName}`,
        detail: err.message || String(err),
        request_id,
        code: 'E_FETCH_FAILED'
      });
      throw err;
    }
  };

  // Jobs interceptor (App Proxy → Netlify functions)
  if (suffix === "/v3/billing/status")    return await forwardToFunction("billing-status");
  if (suffix === "/v3/billing/subscribe") return await forwardToFunction("billing-subscribe");
  if (suffix === "/v3/job/start")  return await forwardToFunction("start");
  if (suffix === "/v3/job/result") return await forwardToFunction("result");
  if (suffix === "/v3/billing/allow") return await forwardToFunction("billing-allow");
  if (suffix === "/v3/usage/mark")    return await forwardToFunction("usage-mark");

  if (suffix === "/v3/vault/list")   return await forwardToFunction("vault-list");
  if (suffix === "/v3/vault/add")    return await forwardToFunction("vault-add");
  if (suffix === "/v3/vault/update") return await forwardToFunction("vault-update");
  if (suffix === "/v3/vault/delete") return await forwardToFunction("vault-delete");
  if (suffix === "/v3/vault/_alive") return await forwardToFunction("vault-alive");
  /* ──────────────────────────────────────────────────────────── */

  // 2) everything else → forward to n8n
  try {
    const base = (process.env.N8N_ENGINE_BASE_URL || process.env.N8N_ENGINE_WEBHOOK_URL || "").replace(/\/$/, "");
    if (!base) return json(500, { error: "missing N8N_ENGINE_BASE_URL" });

    const qs = new URLSearchParams(url.searchParams);
    qs.delete("signature");
    const path = suffix === "/" ? "/run" : suffix;
    const target = `${base}${path}${qs.toString() ? `?${qs}` : ""}`;

    const method = event.httpMethod || "GET";
    const needsBody = ["POST", "PUT", "PATCH"].includes(method);
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : (event.body || "");

    const resp = await fetch(target, {
      method,
      headers: {
        "Content-Type":
          event.headers?.["content-type"] ||
          event.headers?.["Content-Type"] ||
          "application/json",
        "X-Channel": "shopify-proxy",
        "X-Shop": shop,
        "X-Logged-In-Customer-Id": url.searchParams.get("logged_in_customer_id") || "",
        "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || "",
        "X-Seoboss-Ts": String(Math.floor(Date.now() / 1000)),
        // ✅ ADD THIS - Forward correlation ID to n8n
        "X-Request-Id": request_id,
      },
      body: needsBody ? rawBody : undefined,
    });

    // ✅ ADD THIS - Log if n8n fails
    if (!resp.ok && resp.status >= 500) {
      const errorText = await resp.clone().text();
      await errlog({
        shop,
        route: `/engine-proxy → n8n${path}`,
        status: resp.status,
        message: `n8n endpoint ${path} failed`,
        detail: errorText.slice(0, 500),
        request_id,
        code: 'E_N8N_FAILED'
      });
    }

    const text = await resp.text();
    return {
      statusCode: resp.status,
      headers: {
        "Content-Type": resp.headers.get("content-type") || "application/json",
        "Access-Control-Allow-Origin": ORIGIN,
        "Access-Control-Expose-Headers": "Content-Type",
      },
      body: text,
    };
  } catch (err) {
    // ✅ ADD THIS - Log n8n fetch failures
    await errlog({
      shop,
      route: '/engine-proxy → n8n',
      status: 500,
      message: 'Failed to reach n8n',
      detail: err.message || String(err),
      request_id,
      code: 'E_N8N_UNREACHABLE'
    });
    
    return json(502, { error: "n8n unreachable", detail: err.message });
  }
};
