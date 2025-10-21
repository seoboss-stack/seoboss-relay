// netlify/functions/create-engine-page.mjs
import crypto from "node:crypto";
import { errlog } from './_lib/_errlog.mjs';  // ✅ ADD THIS

// --- helpers (same normalization you use elsewhere) ---
const normShop = (s = "") =>
  String(s).trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/.*/, "")
    .replace(/:\d+$/, "")
    .replace(/\.shopify\.com$/i, ".myshopify.com");

function json(status, data) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "https://seoboss.com", // match your UI origin
      "Access-Control-Expose-Headers": "Content-Type",
    },
    body: JSON.stringify(data),
  };
}

async function getShopTokenViaFn({ shop, client_id, forwardSecret }) {
  // Call your existing Netlify function to decrypt token
  const url = new URL(`/.netlify/functions/get-shop-token`, `http://localhost`);
  const rsp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SEOBOSS-FORWARD-SECRET": forwardSecret || "",
    },
    body: JSON.stringify({ shop, client_id }),
  });
  if (!rsp.ok) throw new Error(`get-shop-token failed: ${await rsp.text()}`);
  return rsp.json(); // { shop, token }
}

export const handler = async (event) => {
  // ✅ ADD THIS - Extract request_id early
  const request_id = event.headers?.["x-request-id"] || event.headers?.["X-Request-Id"] || '';

  try {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 204,
        headers: {
          "Access-Control-Allow-Origin": "https://seoboss.com",
          "Access-Control-Allow-Headers": "Content-Type,X-Seoboss-Ts,X-Seoboss-Hmac,X-Seoboss-Key-Id,X-SEOBOSS-FORWARD-SECRET",
          "Access-Control-Allow-Methods": "POST,OPTIONS",
        },
        body: "",
      };
    }

    if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

    // backend→backend guard (like your other functions)
    const fwd = event.headers?.["x-seoboss-forward-secret"] || event.headers?.["X-Seoboss-Forward-Secret"] || "";
    if (!process.env.FORWARD_SECRET || fwd !== process.env.FORWARD_SECRET) {
      return json(401, { error: "forbidden" });
    }

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}
    const rawShop = body.shop || "";
    const client_id = (body.client_id || "").trim();
    const title = (body.title || "SEOBoss Console").trim();

    const shop = normShop(rawShop);
    if (!shop && !client_id) return json(400, { error: "shop or client_id required" });

    // 1) get Admin token
    let token;
    try {
      const result = await getShopTokenViaFn({ shop, client_id, forwardSecret: process.env.FORWARD_SECRET });
      token = result.token;
    } catch (err) {
      // ✅ ADD THIS - Log token retrieval failure
      await errlog({
        shop,
        route: '/create-engine-page',
        status: 500,
        message: 'Failed to retrieve shop token',
        detail: err.message || String(err),
        request_id,
        code: 'E_TOKEN_RETRIEVAL',
        client_id
      });
      return json(500, { error: 'token_retrieval_failed', detail: err.message });
    }

    const host = shop || ""; // may be filled by get-shop-token, but we already normalized
    const api = `https://${host}/admin/api/2024-10`;

    // 2) find existing page by title (simple + good enough for V1)
    let page = null;
    {
      const rsp = await fetch(`${api}/pages.json?limit=10&title=${encodeURIComponent(title)}`, {
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      });
      
      // ✅ ADD THIS - Log Shopify API list failure
      if (!rsp.ok) {
        const rawText = await rsp.text();
        await errlog({
          shop,
          route: '/create-engine-page',
          status: rsp.status,
          message: 'Shopify list pages API failed',
          detail: rawText,
          request_id,
          code: 'E_SHOPIFY_API',
          client_id
        });
        return json(rsp.status, { error: `list pages failed`, raw: rawText });
      }
      
      const d = await rsp.json();
      page = Array.isArray(d.pages) && d.pages.find(p => (p.title || "").toLowerCase() === title.toLowerCase()) || null;
    }

    // 3) desired body_html: embed your engine via App Proxy (always client_id-tied)
    const qs = new URLSearchParams({ shop: host });
    if (client_id) qs.set("client_id", client_id);
    const iframeSrc = `/apps/seoboss/page?${qs.toString()}`;
    const body_html = `<div style="min-height:70vh"><iframe src="${iframeSrc}" style="width:100%;min-height:80vh;border:0" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe></div>`;

    // 4) create or update
    if (!page) {
      const createRsp = await fetch(`${api}/pages.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({
          page: {
            title,
            body_html,
            published: true, // make it live; theme may not link to it, but URL works
          }
        })
      });
      
      // ✅ ADD THIS - Log page creation failure
      if (!createRsp.ok) {
        const rawText = await createRsp.text();
        await errlog({
          shop,
          route: '/create-engine-page',
          status: createRsp.status,
          message: 'Shopify create page API failed',
          detail: rawText,
          request_id,
          code: 'E_SHOPIFY_API',
          client_id
        });
        return json(createRsp.status, { error: "create page failed", raw: rawText });
      }
      
      const out = await createRsp.json();
      page = out.page;
    } else {
      const updRsp = await fetch(`${api}/pages/${page.id}.json`, {
        method: "PUT",
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({
          page: {
            id: page.id,
            title,        // keep in sync
            body_html,    // refresh content
            published: true,
          }
        })
      });
      
      // ✅ ADD THIS - Log page update failure
      if (!updRsp.ok) {
        const rawText = await updRsp.text();
        await errlog({
          shop,
          route: '/create-engine-page',
          status: updRsp.status,
          message: 'Shopify update page API failed',
          detail: rawText,
          request_id,
          code: 'E_SHOPIFY_API',
          client_id
        });
        return json(updRsp.status, { error: "update page failed", raw: rawText });
      }
      
      const out = await updRsp.json();
      page = out.page;
    }

    // 5) return the canonical page URL
    const handle = page.handle || (page.admin_graphql_api_id || "").split("/").pop() || "seoboss-console";
    const url = `https://${host}/pages/${handle}`;

    return json(200, { ok: true, url, page_id: page.id, handle, shop: host, client_id });
    
  } catch (e) {
    // ✅ ADD THIS - Log uncaught exceptions
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}
    
    await errlog({
      shop: normShop(body.shop || ''),
      route: '/create-engine-page',
      status: 500,
      message: 'Uncaught exception in create-engine-page',
      detail: e.stack || String(e),
      request_id,
      code: 'E_EXCEPTION',
      client_id: body.client_id || ''
    });
    
    return json(500, { error: e?.message || String(e) });
  }
};
