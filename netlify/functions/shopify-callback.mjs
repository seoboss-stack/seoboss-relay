// netlify/functions/shopify-callback.mjs
import crypto from "node:crypto";
import { logFnError } from "./log.mjs";

// ---------- helpers ----------
function parseCookies(header = "") {
  return Object.fromEntries(
    (header || "").split(/; */).filter(Boolean).map((c) => {
      const i = c.indexOf("="); if (i === -1) return [c, ""];
      return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
    })
  );
}

const normShop = (s = "") =>
  String(s).trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/.*/, "")
    .replace(/:\d+$/, "")
    .replace(/\.shopify\.com$/i, ".myshopify.com");

// Build your public base URL for webhook targets
function publicBaseUrl(event) {
  const env = process.env.PUBLIC_BASE_URL || process.env.APP_URL || "";
  if (env) return env.replace(/\/$/, "");
  const proto = event.headers?.["x-forwarded-proto"] || "https";
  const host  = event.headers?.["x-forwarded-host"] || event.headers?.host || "";
  return `${proto}://${host}`;
}

// Register app/uninstalled + GDPR webhooks to your Netlify functions
async function registerWebhooks({ shop, access_token, baseUrl }) {
  const apiBase = `https://${shop}/admin/api/2024-10`;
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": access_token,
  };

  const targets = [
    { topic: "app/uninstalled",           address: `${baseUrl}/.netlify/functions/uninstalled` },
    { topic: "customers/data_request",    address: `${baseUrl}/.netlify/functions/privacy` },
    { topic: "customers/redact",          address: `${baseUrl}/.netlify/functions/privacy` },
    { topic: "shop/redact",               address: `${baseUrl}/.netlify/functions/privacy` },
  ];

  // Fetch existing once
  const listRes = await fetch(`${apiBase}/webhooks.json`, { headers });
  if (!listRes.ok) throw new Error(`list webhooks: ${listRes.status} ${await listRes.text()}`);
  const existing = (await listRes.json())?.webhooks || [];

  // Ensure each topic@address exists (idempotent)
  for (const { topic, address } of targets) {
    const already = existing.some(w => w.topic === topic && w.address === address);
    if (already) continue;

    const create = await fetch(`${apiBase}/webhooks.json`, {
      method: "POST",
      headers,
      body: JSON.stringify({ webhook: { topic, address, format: "json" } }),
    });
    if (!create.ok) throw new Error(`create ${topic}: ${create.status} ${await create.text()}`);
  }
}

// Store token in Supabase vault via your Netlify helper
async function storeTokenVault({ shop, access_token }) {
  const url = `${process.env.PUBLIC_BASE_URL || process.env.APP_URL}/.netlify/functions/store-shop-token`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || "",
    },
    body: JSON.stringify({ shop, token: access_token }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`store-shop-token failed: ${res.status} ${txt}`);
  }
}

// ---------- handler ----------
export const handler = async (event) => {
  const request_id = event.headers?.["x-nf-request-id"] || "";
  let shop = "";

  try {
    const API_KEY        = process.env.SHOPIFY_API_KEY_PUBLIC || process.env.SHOPIFY_API_KEY || "";
    const SECRET         = process.env.SHOPIFY_APP_SECRET_PUBLIC || process.env.SHOPIFY_APP_SECRET || "";
    const ONBOARD_URL    = process.env.N8N_ONBOARD_SUBMIT_URL; // https://.../webhook/seoboss/api/onboarding/submit
    const PUBLIC_HMAC_KEY= process.env.PUBLIC_HMAC_KEY || "";
    const FWD_SECRET     = process.env.FORWARD_SECRET || "";

    if (!API_KEY || !SECRET)  return { statusCode: 500, body: "missing API key/secret" };
    if (!ONBOARD_URL)         return { statusCode: 500, body: "missing N8N_ONBOARD_SUBMIT_URL" };

    const url = new URL(event.rawUrl);
    const q = Object.fromEntries(url.searchParams.entries());
    const { shop: rawShop, hmac, code, state, timestamp } = q;

    // Validate shop + state
    shop = normShop(rawShop);
    const shopRe = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
    if (!shopRe.test(shop || ""))        return { statusCode: 400, body: "invalid shop" };
    const cookies = parseCookies(event.headers?.cookie || event.headers?.Cookie || "");
    if (!state || cookies.shopify_oauth_state !== state) return { statusCode: 401, body: "bad state" };

    // Anti-replay + HMAC on callback params
    const ts = Number(timestamp || 0);
    if (!ts || Math.abs(Date.now()/1000 - ts) > 600) return { statusCode: 401, body: "stale oauth" };
    if (!hmac || !code)                               return { statusCode: 400, body: "missing params" };

    const message = Object.keys(q)
      .filter(k => k !== "hmac" && k !== "signature")
      .sort().map(k => `${k}=${q[k]}`).join("&");
    const digest = crypto.createHmac("sha256", SECRET).update(message).digest("hex");
    const safe = hmac.length === digest.length &&
      crypto.timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(digest, "hex"));
    if (!safe) return { statusCode: 401, body: "invalid hmac" };

    // Exchange code -> offline access token
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: API_KEY, client_secret: SECRET, code }),
    });
    if (!tokenRes.ok) {
      const errTxt = await tokenRes.text();
      return { statusCode: 502, body: `token exchange failed: ${errTxt}` };
    }
    const { access_token /*, scope */ } = await tokenRes.json();

    // Store token securely (don’t ship raw token to n8n)
    try {
      await storeTokenVault({ shop, access_token });
    } catch (e) {
      try { await logFnError({ fn: "shopify-callback/store-token", shop, status: 500, message: e?.message || String(e), request_id }); } catch {}
      // non-blocking
    }

    // Register webhooks (non-blocking, log if fails)
    try {
      await registerWebhooks({
        shop,
        access_token,
        baseUrl: publicBaseUrl(event),
      });
    } catch (e) {
      try { await logFnError({ fn: "shopify-callback/register-webhooks", shop, status: 500, message: e?.message || String(e), request_id }); } catch {}
      // non-blocking
    }

    // Hand off to your onboarding flow (form-encoded, HMAC-signed) WITHOUT token
    const bodyForm = new URLSearchParams({
      client_name: "",
      contact_email: "",
      default_language: "en",
      shop_input: shop,          // sanitize node expects this
      tone: "",
      niche: "",
      seed_keywords: "",
      target_audience: ""
    }).toString();

    const ts2 = String(Math.floor(Date.now()/1000));
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-SEOBOSS-FORWARD-SECRET": FWD_SECRET,
      "X-Seoboss-Ts": ts2,
      "X-Seoboss-Key-Id": "global",
    };
    if (PUBLIC_HMAC_KEY) {
      const sig = crypto.createHmac("sha256", PUBLIC_HMAC_KEY).update(bodyForm + "\n" + ts2).digest("hex");
      headers["X-Seoboss-Hmac"] = sig;
    }

    try { await fetch(ONBOARD_URL, { method: "POST", headers, body: bodyForm }); } catch {}

    // Redirect to your connect page
    return {
      statusCode: 302,
      headers: {
        Location: `https://seoboss.com/pages/connect?shop=${encodeURIComponent(shop)}&installed=1`,
        "Set-Cookie": "shopify_oauth_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
      },
      body: "",
    };

  } catch (e) {
    try {
      await logFnError({
        fn: "shopify-callback",
        shop,
        status: e?.status || 500,
        message: e?.message || String(e),
        request_id,
        stack: e?.stack || null,
      });
    } catch {}
    return {
      statusCode: 302,
      headers: {
        Location: `https://seoboss.com/pages/connect?shop=${encodeURIComponent(shop || "")}&installed=1`,
      },
      body: "",
    };
  }
};
