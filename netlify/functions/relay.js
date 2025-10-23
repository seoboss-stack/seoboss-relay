// netlify/functions/relay.js — secure API relay (with Shopify origin allow + logging)
import crypto from "crypto";
import { errlog } from './_lib/_errlog.mjs';  // ✅ ADD THIS

// ===== ALLOWLIST (no env required) =====
// - Your site
// - Your specific myshopify domain
// - Shopify Admin (useful when testing in Theme Editor)
// - Any *.myshopify.com storefront (suffix match)
const STATIC_ALLOW = new Set([
  "https://seoboss.com",
  "https://hooks.seoboss.com",     // ← ADD THIS LINE!
  "https://t5wicb-gi.myshopify.com",
  "https://admin.shopify.com",
]);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (STATIC_ALLOW.has(origin)) return true;
  try {
    const u = new URL(origin);
    return u.hostname.endsWith(".myshopify.com");
  } catch {
    return false;
  }
}

// ===== Route map (unchanged) =====
const ROUTE_MAP = {
  // Engine
  "/seoboss/api/hints":                "N8N_HINTS_URL",
  "/seoboss/api/blog-titles":          "N8N_TITLES_URL",
  "/seoboss/api/blog-post":            "N8N_POST_URL",
  "/seoboss/api/trending-questions":   "N8N_TRENDING_QS_URL",
  "/seoboss/api/trending-searches":    "N8N_TRENDING_SEARCHES_URL",
  

  // Onboarding
  "/seoboss/api/onboarding/submit":    "N8N_ONBOARD_SUBMIT_URL",
  "/seoboss/api/onboarding/activate":  "N8N_ONBOARD_ACTIVATE_URL",
  "/seoboss/api/onboarding/resend":    "N8N_ONBOARD_RESEND_URL",
  "/seoboss/api/client/profile":       "N8N_CLIENT_PROFILE_URL",
  "/seoboss/api/shop/blogs":           "N8N_SHOP_LIST_BLOGS_URL",
  "/seoboss/api/shop/import-articles": "N8N_SHOP_IMPORT_URL",

  // Provider (Shopify webhooks etc.) — skips browser HMAC
  "/seoboss/api/shopify":              "N8N_SHOPIFY_URL",
};

const DEBUG = process.env.DEBUG_RELAY === "1";
const MAX_BODY = 1_000_000; // ~1MB guard

function isProviderRoute(path) {
  return path === "/seoboss/api/shopify";
}

function timingSafeEqHex(hexA, hexB) {
  const A = Buffer.from(String(hexA || ""), "hex");
  const B = Buffer.from(String(hexB || ""), "hex");
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function corsHeaders(origin, isProvider) {
  if (isProvider) return {}; // providers (Shopify) manage their own auth; no browser CORS needed
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Seoboss-Ts, X-Seoboss-Hmac, X-Seoboss-Key-Id",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
}

function securityHeaders() {
  return { "Cache-Control": "no-store" };
}

function json(statusCode, bodyObj, origin, isProvider) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...securityHeaders(),
      ...corsHeaders(origin, isProvider),
    },
    body: JSON.stringify(bodyObj),
  };
}

export const handler = async (event) => {  // ✅ CHANGED: exports.handler → export const handler
  const started = Date.now();
  const rid = Math.random().toString(36).slice(2, 8);
  
  // ✅ ADD THIS - Extract request_id early
  const request_id = event.headers?.["x-request-id"] || event.headers?.["X-Request-Id"] || rid;

  const origin =
    event.headers.origin ||
    event.headers.Origin ||
    event.headers.ORGIGIN || // seen weird proxies
    "";

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    const allow = isAllowedOrigin(origin) ? origin : "https://seoboss.com";
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": allow,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Seoboss-Ts, X-Seoboss-Hmac, X-Seoboss-Key-Id",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin",
        ...securityHeaders(),
      },
    };
  }

  if (event.httpMethod !== "POST") {
    console.log(`[relay] rid=${rid} 405 method=${event.httpMethod}`);
    return json(405, { ok: false, error: "method_not_allowed" }, origin, false);
  }

  // Normalize path (strip Netlify function prefix, decode, trim trailing slash)
  let path = event.path || "";
  path = path.replace("/.netlify/functions/relay", "");
  try { path = decodeURIComponent(path); } catch {}
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  const envKey = ROUTE_MAP[path];
  const upstream = envKey ? process.env[envKey] : null;
  const provider = isProviderRoute(path);

  console.log(`[relay] rid=${rid} start path=${path} origin=${origin || "-"} provider=${provider}`);

  if (!upstream) {
    console.log(`[relay] rid=${rid} 404 unknown_route`);
    return json(404, { ok: false, error: "unknown_route", path }, origin, provider);
  }

  // Enforce browser origin (skip for provider routes)
  if (!provider && !isAllowedOrigin(origin)) {
    console.log(`[relay] rid=${rid} 403 forbidden_origin`);
    return json(403, { ok: false, error: "forbidden_origin" }, origin, provider);
  }

  // Body guard
  const raw = event.body || "";
  if (raw.length > MAX_BODY) {
    console.log(`[relay] rid=${rid} 413 payload_too_large len=${raw.length}`);
    return json(413, { ok: false, error: "payload_too_large" }, origin, provider);
  }

  // Verify HMAC (skip for provider routes)
  if (!provider) {
    const tsHeader = event.headers["x-seoboss-ts"] || event.headers["X-Seoboss-Ts"];
    const hmacHeader = (event.headers["x-seoboss-hmac"] || event.headers["X-Seoboss-Hmac"] || "").toLowerCase();

    const ts = parseInt(tsHeader || "0", 10);
    if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) {
      console.log(`[relay] rid=${rid} 401 stale_ts ts=${tsHeader || "-"}`);
      return json(401, { ok: false, error: "stale_or_missing_timestamp" }, origin, provider);
    }
    if (!hmacHeader || !process.env.PUBLIC_HMAC_KEY) {
      console.log(`[relay] rid=${rid} 401 missing_hmac`);
      return json(401, { ok: false, error: "missing_hmac_or_key" }, origin, provider);
    }

    const expected = crypto.createHmac("sha256", process.env.PUBLIC_HMAC_KEY)
      .update(raw + "\n" + ts)
      .digest("hex");

    if (!timingSafeEqHex(expected, hmacHeader)) {
      if (DEBUG) console.error(`[relay] rid=${rid} 401 bad_sig exp=${expected.slice(0,8)} got=${hmacHeader.slice(0,8)}`);
      return json(401, { ok: false, error: "bad_signature" }, origin, provider);
    }
  }

  // Forward to n8n with a safety timeout (60s)
  try {
    const ct =
      event.headers["content-type"] ||
      event.headers["Content-Type"] ||
      "application/x-www-form-urlencoded";

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 60_000);

    const resp = await fetch(upstream, {
      method: "POST",
      headers: {
        "Content-Type": ct,
        "Accept": "application/json",
        "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || "",
        "X-Seoboss-Ts": event.headers["x-seoboss-ts"] || event.headers["X-Seoboss-Ts"] || "",
        "X-Seoboss-Hmac": event.headers["x-seoboss-hmac"] || event.headers["X-Seoboss-Hmac"] || "",
        "X-Seoboss-Key-Id": event.headers["x-seoboss-key-id"] || event.headers["X-Seoboss-Key-Id"] || "",
        "X-Request-Id": request_id,  // ✅ ADD THIS - Forward correlation ID
      },
      body: raw,
      signal: controller.signal,
    });

    clearTimeout(t);

    // ✅ ADD THIS - Log if n8n returns 500+
    if (resp.status >= 500) {
      const errorText = await resp.clone().text();
      await errlog({
        shop: '', // Relay doesn't always have shop context
        route: `/relay${path}`,
        status: resp.status,
        message: `n8n endpoint ${path} returned error`,
        detail: errorText.slice(0, 500),
        request_id,
        code: 'E_N8N_FAILED'
      }).catch(() => {}); // Fire and forget
    }

    const text = await resp.text();
    const contentType = resp.headers.get("content-type") || "application/json";

    console.log(`[relay] rid=${rid} upstream=${resp.status} dur_ms=${Date.now() - started}`);

    // Pass-through (ensure CORS back to the browser)
    return {
      statusCode: resp.status,
      headers: {
        "Content-Type": contentType,
        ...securityHeaders(),
        ...corsHeaders(origin, provider),
      },
      body: text,
    };
  } catch (err) {
    // ✅ ADD THIS - Log fetch failures
    await errlog({
      shop: '',
      route: `/relay${path}`,
      status: 502,
      message: `Failed to reach n8n endpoint ${path}`,
      detail: err.message || String(err),
      request_id,
      code: 'E_N8N_UNREACHABLE'
    }).catch(() => {}); // Fire and forget
    
    console.log(`[relay] rid=${rid} 502 upstream_error dur_ms=${Date.now() - started} msg=${err.message}`);
    return json(502, { ok: false, error: "upstream_error" }, origin, provider);
  }
};
