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


const ORIGIN = "https://admin.shopify.com"; // CORS for n8n-forwarded routes

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
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>SEOBoss Console</title>
  <style>
    html,body{margin:0;height:100%;background:#0f1421;color:#e8fff6;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Inter,sans-serif}
    #seoboss-console{min-height:100vh}
  </style>
</head>
<body>
  <div id="seoboss-console" data-client-id="${clientId}" data-shop="${shop}"></div>
  <script async src="/apps/engine/widget.js"></script>
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

    // persist hints (harmless if unused)
    try {
      var cid = host.getAttribute('data-client-id') || '';
      var shop = host.getAttribute('data-shop') || '';
      var prev = JSON.parse(localStorage.getItem('seoboss:client') || '{}');
      localStorage.setItem('seoboss:client', JSON.stringify({ ...prev, id: cid, shop_url: shop }));
    } catch(e){}

    // endpoints your engine expects through the App Proxy
    window.CONFIG = window.CONFIG || {};
    window.CONFIG.endpoints = window.CONFIG.endpoints || {
      hints:  "/apps/engine/hints",
      titles: "/apps/engine/blog-titles",
      post:   "/apps/engine/blog-post",
      alive:  "/apps/engine/_alive"
    };

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

  
// ── Asset passthrough: /apps/engine/assets/:file ─────────────────────────────
if (suffix.startsWith("/assets/")) {
  const file = suffix.replace(/^\/assets\//, "");
  const cdn = ASSET_MAP[file];
  if (!cdn) return { statusCode: 404, body: "asset not mapped" };

  try {
    const r = await fetch(cdn, { redirect: "follow" });
    const body = await r.arrayBuffer();
    const isCSS = file.endsWith(".css");
    const isJS  = file.endsWith(".js");

    return {
      statusCode: r.status,
      headers: {
        "Content-Type": isCSS ? "text/css; charset=utf-8"
                    : isJS  ? "application/javascript; charset=utf-8"
                            : (r.headers.get("content-type") || "application/octet-stream"),
        "Cache-Control": "public, max-age=300, s-maxage=300", // short cache to pick up new CLI pushes
        "Access-Control-Allow-Origin": "*", // harmless; request is same-origin anyway
      },
      body: Buffer.from(body).toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) {
    return { statusCode: 502, body: "upstream asset fetch failed" };
  }
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
