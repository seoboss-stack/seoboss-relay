// netlify/functions/relay.js — secure API relay (hardened)
const crypto = require("crypto");

const ALLOW_ORIGINS = new Set([
  "https://seoboss.com",
  // "http://localhost:3000", // ← uncomment when testing locally
]);

const ROUTE_MAP = {
  // Engine
  "/seoboss/api/hints":                "N8N_HINTS_URL",
  "/seoboss/api/blog-titles":          "N8N_TITLES_URL",
  "/seoboss/api/blog-post":            "N8N_POST_URL",
  "/seoboss/api/trending-questions":   "N8N_TRENDING_QS_URL",
  "/seoboss/api/trending-searches":    "N8N_TRENDING_SEARCHES_URL",
  "/seoboss/api/vault-add":            "N8N_VAULT_ADD_URL",
  "/seoboss/api/vault-load":           "N8N_VAULT_LOAD_URL",

  // Onboarding
  "/seoboss/api/onboarding/submit":    "N8N_ONBOARD_SUBMIT_URL",
  "/seoboss/api/onboarding/activate":  "N8N_ONBOARD_ACTIVATE_URL",
  "/seoboss/api/onboarding/resend":    "N8N_ONBOARD_RESEND_URL",
  "/seoboss/api/client/profile":       "N8N_CLIENT_PROFILE_URL",
  "/seoboss/api/shop/blogs":           "N8N_SHOP_LIST_BLOGS_URL",
  "/seoboss/api/shop/import-articles": "N8N_SHOP_IMPORT_URL",

  // Provider (Shopify webhooks etc.)
  "/seoboss/api/shopify":              "N8N_SHOPIFY_URL",
};

const DEBUG = process.env.DEBUG_RELAY === "1";
const MAX_BODY = 1_000_000; // ~1MB guard

function isProviderRoute(path) {
  return path === "/seoboss/api/shopify";
}

function timingSafeEq(a, b) {
  const A = Buffer.from(a, "hex");
  const B = Buffer.from(b, "hex");
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function baseCors(origin) {
  return origin
    ? {
        "Access-Control-Allow-Origin": origin,
        "Vary": "Origin",
      }
    : {};
}

// Full CORS for non-provider routes
function corsHeaders(origin, isProvider) {
  if (isProvider) return {};
  return {
    ...baseCors(origin),
    "Access-Control-Allow-Headers":
      "Content-Type, X-Seoboss-Ts, X-Seoboss-Hmac, X-Seoboss-Key-Id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function commonSecurity() {
  return {
    "Cache-Control": "no-store",
  };
}

function json(statusCode, bodyObj, origin, isProvider) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...commonSecurity(),
      ...corsHeaders(origin, isProvider),
    },
    body: JSON.stringify(bodyObj),
  };
}

exports.handler = async (event) => {
  const origin =
    event.headers.origin ||
    event.headers.Origin ||
    event.headers.ORGIGIN || // (seen weird proxies)
    "";

  // --- CORS preflight ---
  if (event.httpMethod === "OPTIONS") {
    const allow =
      (origin && ALLOW_ORIGINS.has(origin) && origin) ||
      Array.from(ALLOW_ORIGINS)[0] ||
      "*";
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": allow,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, X-Seoboss-Ts, X-Seoboss-Hmac, X-Seoboss-Key-Id",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin",
        ...commonSecurity(),
      },
    };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" }, origin, false);
  }

  // --- Normalize path (strip Netlify prefix and trailing slash, decode) ---
  let path = event.path || "";
  path = path.replace("/.netlify/functions/relay", "");
  try {
    path = decodeURIComponent(path);
  } catch {}
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  const envKey = ROUTE_MAP[path];
  const upstream = envKey ? process.env[envKey] : null;
  const isProvider = isProviderRoute(path);

  if (!upstream) {
    return json(
      404,
      { ok: false, error: "Unknown route", path },
      origin,
      isProvider
    );
  }

  // --- Enforce origin for browser calls (skip for provider) ---
  if (!isProvider && !ALLOW_ORIGINS.has(origin)) {
    return json(
      403,
      { ok: false, error: "Forbidden origin" },
      origin,
      isProvider
    );
  }

  // Body size guard (defense-in-depth)
  const raw = event.body || "";
  if (raw.length > MAX_BODY) {
    return json(
      413,
      { ok: false, error: "Payload too large" },
      origin,
      isProvider
    );
  }

  // --- Verify HMAC (skip provider routes) ---
  if (!isProvider) {
    const tsHeader = event.headers["x-seoboss-ts"] || event.headers["X-Seoboss-Ts"];
    const hmacHeader = (
      event.headers["x-seoboss-hmac"] ||
      event.headers["X-Seoboss-Hmac"] ||
      ""
    ).toLowerCase();

    const ts = parseInt(tsHeader || "0", 10);
    if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) {
      return json(
        401,
        { ok: false, error: "Stale or missing timestamp" },
        origin,
        isProvider
      );
    }
    if (!hmacHeader || !process.env.PUBLIC_HMAC_KEY) {
      return json(
        401,
        { ok: false, error: "Missing HMAC or key" },
        origin,
        isProvider
      );
    }

    const expected = crypto
      .createHmac("sha256", process.env.PUBLIC_HMAC_KEY)
      .update(raw + "\n" + ts)
      .digest("hex");

    if (!timingSafeEq(expected, hmacHeader)) {
      if (DEBUG) console.error("HMAC mismatch", { expected, got: hmacHeader });
      return json(
        401,
        { ok: false, error: "Bad signature" },
        origin,
        isProvider
      );
    }
  }

  // --- Forward to n8n ---
  try {
    const ct =
      event.headers["content-type"] ||
      event.headers["Content-Type"] ||
      "application/x-www-form-urlencoded";

    const resp = await fetch(upstream, {
      method: "POST",
      headers: {
        "Content-Type": ct,
        "Accept": "application/json",
        "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET,
        "X-Seoboss-Ts":
          event.headers["x-seoboss-ts"] || event.headers["X-Seoboss-Ts"] || "",
        "X-Seoboss-Hmac":
          event.headers["x-seoboss-hmac"] ||
          event.headers["X-Seoboss-Hmac"] ||
          "",
        "X-Seoboss-Key-Id":
          event.headers["x-seoboss-key-id"] ||
          event.headers["X-Seoboss-Key-Id"] ||
          "",
      },
      body: raw,
    });

    const text = await resp.text();
    const contentType = resp.headers.get("content-type") || "application/json";

    return {
      statusCode: resp.status,
      headers: {
        "Content-Type": contentType,
        ...commonSecurity(),
        ...corsHeaders(origin, isProvider),
      },
      body: text,
    };
  } catch (err) {
    if (DEBUG) console.error("Upstream error:", err);
    return json(
      502,
      { ok: false, error: "Upstream error" },
      origin,
      isProvider
    );
  }
};
