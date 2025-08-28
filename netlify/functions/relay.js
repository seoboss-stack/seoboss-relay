// netlify/functions/relay.js — secure API relay
const crypto = require("crypto");

const ALLOW_ORIGINS = new Set([
  "https://seoboss.com",
  // "http://localhost:3000", // enable if testing locally
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

function isProviderRoute(path) {
  return path === "/seoboss/api/shopify";
}

function timingSafeEq(a, b) {
  const A = Buffer.from(a, "hex");
  const B = Buffer.from(b, "hex");
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// ✅ helper: JSON response that always includes CORS for non-provider routes
function json(statusCode, bodyObj, origin, isProvider) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...(isProvider ? {} : (origin ? { "Access-Control-Allow-Origin": origin } : {})),
    },
    body: JSON.stringify(bodyObj),
  };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || "";

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    const anyOrigin = Array.from(ALLOW_ORIGINS)[0] || "*";
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": anyOrigin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, X-Seoboss-Ts, X-Seoboss-Hmac, X-Seoboss-Key-Id",
      },
    };
  }

  if (event.httpMethod !== "POST") {
    // include CORS even on 405
    return json(405, { ok: false, error: "Method not allowed" }, origin, false);
  }

  // Normalize path (strip Netlify prefix if present)
  let path = event.path || "";
  path = path.replace("/.netlify/functions/relay", "");

  const envKey = ROUTE_MAP[path];
  const upstream = envKey ? process.env[envKey] : null;
  const isProvider = isProviderRoute(path);

  if (!upstream) {
    return json(404, { ok: false, error: "Unknown route", path }, origin, isProvider);
  }

  // Enforce origin for browser calls (skip for provider)
  if (!isProvider && !ALLOW_ORIGINS.has(origin)) {
    return json(403, { ok: false, error: "Forbidden origin" }, origin, isProvider);
  }

  // Verify HMAC (skip Shopify/provider routes)
  if (!isProvider) {
    const tsHeader =
      event.headers["x-seoboss-ts"] || event.headers["X-Seoboss-Ts"];
    const hmacHeader =
      (event.headers["x-seoboss-hmac"] ||
        event.headers["X-Seoboss-Hmac"] ||
        "").toLowerCase();

    const ts = parseInt(tsHeader || "0", 10);
    if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) {
      return json(401, { ok: false, error: "Stale or missing timestamp" }, origin, isProvider);
    }
    if (!hmacHeader || !process.env.PUBLIC_HMAC_KEY) {
      return json(401, { ok: false, error: "Missing HMAC or key" }, origin, isProvider);
    }

    const raw = event.body || "";
    const expected = crypto
      .createHmac("sha256", process.env.PUBLIC_HMAC_KEY)
      .update(raw + "\n" + ts)
      .digest("hex");

    if (!timingSafeEq(expected, hmacHeader)) {
      return json(401, { ok: false, error: "Bad signature" }, origin, isProvider);
    }
  }

  // Forward to n8n
  const resp = await fetch(upstream, {
    method: "POST",
    headers: {
      "Content-Type":
        event.headers["content-type"] || "application/x-www-form-urlencoded",
      "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET,
      "X-Seoboss-Ts":
        event.headers["x-seoboss-ts"] || event.headers["X-Seoboss-Ts"] || "",
      "X-Seoboss-Hmac":
        event.headers["x-seoboss-hmac"] || event.headers["X-Seoboss-Hmac"] || "",
      "X-Seoboss-Key-Id":
        event.headers["x-seoboss-key-id"] ||
        event.headers["X-Seoboss-Key-Id"] ||
        "",
    },
    body: event.body,
  });

  const text = await resp.text();
  // include CORS on success, too
  return {
    statusCode: resp.status,
    headers: {
      "Content-Type": "application/json",
      ...(isProvider ? {} : (origin ? { "Access-Control-Allow-Origin": origin } : {})),
    },
    body: text,
  };
};
