// netlify/functions/relay.js — secure API relay for legacy + embedded
import crypto from "crypto";
import { errlog } from "./_lib/_errlog.mjs";

// ===== Allowed origins (add your hosts here) =====
const STATIC_ALLOW = new Set([
  "https://seoboss.com",
  "https://hooks.seoboss.com",
  "https://t5wicb-gi.myshopify.com",
  "https://admin.shopify.com",
]);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (STATIC_ALLOW.has(origin)) return true;
  try { return new URL(origin).hostname.endsWith(".myshopify.com"); }
  catch { return false; }
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
  if (isProvider) return {}; // providers manage their own auth
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Seoboss-Ts, X-Seoboss-Hmac, X-Seoboss-Key-Id",
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

// ---- Embedded helpers (Shopify session token) ----
function readBearer(event) {
  const h = event.headers || {};
  const v = h.authorization || h.Authorization || "";
  const m = /^Bearer\s+(.+)$/.exec(v);
  return m ? m[1] : "";
}
function b64urlDecode(s = "") {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
function decodeShopifyJWT(jwt) {
  const parts = String(jwt || "").split(".");
  if (parts.length < 2) throw new Error("bad_session_token");
  const payload = JSON.parse(b64urlDecode(parts[1]));
  const dest = String(payload.dest || "").replace(/^https?:\/\//, "").toLowerCase();
  if (!dest || !/\.myshopify\.com$/i.test(dest)) throw new Error("bad_dest");
  return { shop: dest, payload };
}

export const handler = async (event) => {
  const started = Date.now();
  const rid = Math.random().toString(36).slice(2, 8);
  const request_id = event.headers?.["x-request-id"] || event.headers?.["X-Request-Id"] || rid;

  const origin =
    event.headers?.origin ||
    event.headers?.Origin ||
    event.headers?.ORGIGIN || // seen weird proxies
    "";

  // ----- CORS preflight -----
  if (event.httpMethod === "OPTIONS") {
    const allow = isAllowedOrigin(origin) ? origin : "https://seoboss.com";
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": allow,
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Seoboss-Ts, X-Seoboss-Hmac, X-Seoboss-Key-Id",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin",
        ...securityHeaders(),
      },
      body: "",
    };
  }

  // ----- Normalize path -----
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

  // ----- GET→POST (optional convenience) -----
  if (event.httpMethod === "GET") {
    // Convert querystring to x-www-form-urlencoded body for n8n flows that expect POST
    try {
      const u = new URL(event.rawUrl || `https://x${event.path}`);
      event.body = u.searchParams.toString();
      event.headers = { ...(event.headers || {}), "content-type": "application/x-www-form-urlencoded" };
    } catch {}
    event.httpMethod = "POST";
  }

  if (event.httpMethod !== "POST") {
    console.log(`[relay] rid=${rid} 405 method=${event.httpMethod}`);
    return json(405, { ok: false, error: "method_not_allowed" }, origin, false);
  }

  // ----- Origin check (skip for provider) -----
  if (!provider && !isAllowedOrigin(origin)) {
    console.log(`[relay] rid=${rid} 403 forbidden_origin`);
    return json(403, { ok: false, error: "forbidden_origin" }, origin, provider);
  }

  // ----- Body guard -----
  const raw = event.body || "";
  if (raw.length > MAX_BODY) {
    console.log(`[relay] rid=${rid} 413 payload_too_large len=${raw.length}`);
    return json(413, { ok: false, error: "payload_too_large" }, origin, provider);
  }

  // ----- Determine mode (embedded vs legacy) -----
  const bearerJwt = readBearer(event);
  let embeddedMode = false;
  let embeddedShop = "";
  if (!provider && bearerJwt) {
    try {
      const d = decodeShopifyJWT(bearerJwt);
      embeddedMode = true;
      embeddedShop = d.shop;
    } catch {
      // Invalid JWT → ignore (fall back to legacy behavior)
    }
  }

  // ----- HMAC verify (legacy) OR server-sign (embedded) -----
  // Legacy path: validate client-provided HMAC
  if (!provider && !embeddedMode) {
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

  // ----- Forward to n8n (with server-side signing for embedded) -----
  try {
    const ct =
      event.headers["content-type"] ||
      event.headers["Content-Type"] ||
      "application/x-www-form-urlencoded";

    // prepare upstream signing headers
    let xTs = event.headers["x-seoboss-ts"] || event.headers["X-Seoboss-Ts"] || "";
    let xHmac = event.headers["x-seoboss-hmac"] || event.headers["X-Seoboss-Hmac"] || "";
    let xKeyId = event.headers["x-seoboss-key-id"] || event.headers["X-Seoboss-Key-Id"] || "global";

    if (!provider && embeddedMode) {
      // Browser didn't (and mustn't) sign. Sign here.
      xTs = String(Math.floor(Date.now() / 1000));
      xKeyId = "global";
      if (process.env.PUBLIC_HMAC_KEY) {
        xHmac = crypto.createHmac("sha256", process.env.PUBLIC_HMAC_KEY)
          .update(raw + "\n" + xTs)
          .digest("hex");
      } else {
        xHmac = "";
      }
    }

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 60_000);

    const resp = await fetch(upstream, {
      method: "POST",
      headers: {
        "Content-Type": ct,
        "Accept": "application/json",
        "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || "",
        "X-Seoboss-Ts": xTs,
        "X-Seoboss-Hmac": xHmac,
        "X-Seoboss-Key-Id": xKeyId,
        "X-Request-Id": request_id,
      },
      body: raw,
      signal: controller.signal,
    });

    clearTimeout(t);

    if (resp.status >= 500) {
      const errorText = await resp.clone().text();
      await errlog({
        shop: embeddedShop || "",
        route: `/relay${path}`,
        status: resp.status,
        message: `n8n endpoint ${path} returned error`,
        detail: errorText.slice(0, 500),
        request_id,
        code: "E_N8N_FAILED",
      }).catch(() => {});
    }

    const text = await resp.text();
    const contentType = resp.headers.get("content-type") || "application/json";

    console.log(`[relay] rid=${rid} upstream=${resp.status} dur_ms=${Date.now() - started}`);

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
    await errlog({
      shop: embeddedShop || "",
      route: `/relay${path}`,
      status: 502,
      message: `Failed to reach n8n endpoint ${path}`,
      detail: err.message || String(err),
      request_id,
      code: "E_N8N_UNREACHABLE",
    }).catch(() => {});
    console.log(`[relay] rid=${rid} 502 upstream_error dur_ms=${Date.now() - started} msg=${err.message}`);
    return json(502, { ok: false, error: "upstream_error" }, origin, provider);
  }
};
