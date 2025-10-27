// netlify/functions/shopify-callback.mjs
import crypto from "node:crypto";
import { errlog } from './_lib/_errlog.mjs';  // ✅ REPLACE OLD IMPORT

// ---------- helpers ----------
function parseCookies(header = "") {
  return Object.fromEntries(
    (header || "")
      .split(/; */)
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf("=");
        if (i === -1) return [c, ""];
        return [c.slice(0, i).trim(), decodeURIComponent(c.slice(1 + i))];
      })
  );
}

const normShop = (s = "") =>
  String(s)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/.*/, "")
    .replace(/:\d+$/, "")
    .replace(/\.shopify\.com$/i, ".myshopify.com");

function publicBaseUrl(event) {
  const env = process.env.PUBLIC_BASE_URL || process.env.APP_URL || "";
  if (env) return env.replace(/\/$/, "");
  const proto = event.headers?.["x-forwarded-proto"] || "https";
  const host = event.headers?.["x-forwarded-host"] || event.headers?.host || "";
  return `${proto}://${host}`;
}

// Register ONLY app/uninstalled via REST (GDPR webhooks are set in Partner Dashboard)
async function registerWebhooks({ shop, access_token, baseUrl }) {
  const apiBase = `https://${shop}/admin/api/2024-10`;
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": access_token,
  };

  const targets = [
    { topic: "app/uninstalled", address: `${baseUrl}/.netlify/functions/uninstalled` },
  ];

  const listRes = await fetch(`${apiBase}/webhooks.json`, { headers });
  if (!listRes.ok) throw new Error(`list webhooks: ${listRes.status} ${await listRes.text()}`);
  const existing = (await listRes.json())?.webhooks || [];

  for (const { topic, address } of targets) {
    const already = existing.some((w) => w.topic === topic && w.address === address);
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

// Fire n8n but never block the user redirect
async function postToN8NFireAndForget({ url, headers, body, timeoutMs = 2500 }) {
  let client_id = "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    }).catch((e) => {
      // aborted or network error → ignore (we don't want to block UX)
      return null;
    });
    if (res && res.ok) {
      try {
        const data = await res.json().catch(() => ({}));
        client_id = data?.client_id || data?.clientId || "";
      } catch {
        // ignore JSON errors
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return client_id;
}

// ---------- handler ----------
export const handler = async (event) => {
  const request_id = event.headers?.["x-nf-request-id"] || event.headers?.["x-request-id"] || "";
  let shop = "";

  try {
    const API_KEY = process.env.SHOPIFY_API_KEY_PUBLIC || process.env.SHOPIFY_API_KEY || "";
    const SECRET = process.env.SHOPIFY_APP_SECRET_PUBLIC || process.env.SHOPIFY_APP_SECRET || "";
    const ONBOARD_URL = process.env.N8N_ONBOARD_SUBMIT_URL; // https://.../webhook/seoboss/api/onboarding/submit
    const PUBLIC_HMAC_KEY = process.env.PUBLIC_HMAC_KEY || "";
    const FWD_SECRET = process.env.FORWARD_SECRET || "";

    if (!API_KEY || !SECRET) {
      // ✅ ADD THIS - Log missing credentials
      await errlog({
        shop: '',
        route: '/shopify-callback',
        status: 500,
        message: 'Missing Shopify API credentials',
        detail: `API_KEY present: ${!!API_KEY}, SECRET present: ${!!SECRET}`,
        request_id,
        code: 'E_CONFIG'
      });
      return { statusCode: 500, body: "missing API key/secret" };
    }

    if (!ONBOARD_URL) {
      // ✅ ADD THIS - Log missing n8n URL
      await errlog({
        shop: '',
        route: '/shopify-callback',
        status: 500,
        message: 'N8N_ONBOARD_SUBMIT_URL not configured',
        detail: 'Cannot complete onboarding flow',
        request_id,
        code: 'E_CONFIG'
      });
      return { statusCode: 500, body: "missing N8N_ONBOARD_SUBMIT_URL" };
    }

    const url = new URL(event.rawUrl);
    const q = Object.fromEntries(url.searchParams.entries());
    const { shop: rawShop, hmac, code, state, timestamp } = q;

    // Validate shop + state
    shop = normShop(rawShop);
    const shopRe = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
    if (!shopRe.test(shop || "")) return { statusCode: 400, body: "invalid shop" };

    // Only enforce state if we actually set a cookie upstream (prevents false 401s)
    const cookies = parseCookies(event.headers?.cookie || event.headers?.Cookie || "");
    if (state && cookies.shopify_oauth_state && cookies.shopify_oauth_state !== state) {
      return { statusCode: 401, body: "bad state" };
    }

    // Anti-replay + HMAC on callback params
    const ts = Number(timestamp || 0);
    if (!ts || Math.abs(Date.now() / 1000 - ts) > 600) return { statusCode: 401, body: "stale oauth" };
    if (!hmac || !code) return { statusCode: 400, body: "missing params" };

    const message = Object.keys(q)
      .filter((k) => k !== "hmac" && k !== "signature")
      .sort()
      .map((k) => `${k}=${q[k]}`)
      .join("&");
    const digest = crypto.createHmac("sha256", SECRET).update(message).digest("hex");
    const safe =
      hmac.length === digest.length &&
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
      
      // ✅ ADD THIS - Log token exchange failure
      await errlog({
        shop,
        route: '/shopify-callback',
        status: tokenRes.status,
        message: 'Shopify token exchange failed',
        detail: errTxt,
        request_id,
        code: 'E_OAUTH_TOKEN_EXCHANGE'
      });
      
      return { statusCode: 502, body: `token exchange failed: ${errTxt}` };
    }
    
    const { access_token /*, scope*/ } = await tokenRes.json();

    // Store token securely (don't ship raw token to n8n in future)
    try {
      await storeTokenVault({ shop, access_token });
    } catch (e) {
      // ✅ REPLACE OLD LOGGING - Use new errlog
      await errlog({
        shop,
        route: '/shopify-callback',
        status: 500,
        message: 'Failed to store access token in vault',
        detail: e?.message || String(e),
        request_id,
        code: 'E_TOKEN_STORAGE'
      }).catch(() => {}); // Fire and forget - don't block redirect
    }

    // Register app/uninstalled webhook
    try {
      await registerWebhooks({ shop, access_token, baseUrl: publicBaseUrl(event) });
    } catch (e) {
      // ✅ REPLACE OLD LOGGING - Use new errlog
      await errlog({
        shop,
        route: '/shopify-callback',
        status: 500,
        message: 'Failed to register webhooks',
        detail: e?.message || String(e),
        request_id,
        code: 'E_WEBHOOK_REGISTRATION'
      }).catch(() => {}); // Fire and forget - don't block redirect
    }

    // 🔔 Provision billing plan (fire-and-forget; do not block redirect)
try {
  const base = process.env.PUBLIC_BASE_URL || process.env.APP_URL || "";
  if (base) {
    const provUrl = `${base.replace(/\/$/,"")}/.netlify/functions/billing-subscribe`;

    const ts3 = String(Math.floor(Date.now() / 1000));
    const bodyJson = JSON.stringify({
      shop,
      plan: "trial",       // or "starter" etc.
      trial_days: 3        // set your trial length or remove this field
    });

    const headers = {
      "Content-Type": "application/json",
      "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || "",
      "X-Request-Id": request_id,
      "X-Seoboss-Ts": ts3,
    };

    // If your billing-subscribe endpoint verifies HMAC, include it (optional)
    if (process.env.PUBLIC_HMAC_KEY) {
      const sig = crypto
        .createHmac("sha256", process.env.PUBLIC_HMAC_KEY)
        .update(bodyJson + "\n" + ts3)
        .digest("hex");
      headers["X-Seoboss-Hmac"] = sig;
    }

    // Reuse the existing fire-and-forget helper (short timeout, don’t block UX)
    postToN8NFireAndForget({
      url: provUrl,
      headers,
      body: bodyJson,
      timeoutMs: 2000,
    }).catch(() => {});
  }
} catch (e) {
  // Log but never block install
  await errlog({
    shop,
    route: '/shopify-callback',
    status: 500,
    message: 'Billing plan provision failed (non-blocking)',
    detail: e?.message || String(e),
    request_id,
    code: 'E_BILLING_PROVISION'
  }).catch(()=>{});
}

    // Prepare one-time onboarding POST to n8n
    const bodyForm = new URLSearchParams({
      client_name: "",
      contact_email: "",
      default_language: "en",
      shop_input: shop, // your sanitize node expects this
      admin_token: access_token, // TEMP: legacy path; migrate to vault fetch in n8n later
      tone: "",
      niche: "",
      seed_keywords: "",
      target_audience: "",
    }).toString();

    const ts2 = String(Math.floor(Date.now() / 1000));
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-SEOBOSS-FORWARD-SECRET": FWD_SECRET,
      "X-Seoboss-Ts": ts2,
      "X-Seoboss-Key-Id": "global",
      "X-Request-Id": request_id,  // ✅ ADD THIS - Forward correlation ID
    };
    if (PUBLIC_HMAC_KEY) {
      const sig = crypto.createHmac("sha256", PUBLIC_HMAC_KEY).update(bodyForm + "\n" + ts2).digest("hex");
      headers["X-Seoboss-Hmac"] = sig;
    }

    // Fire-and-forget n8n with short timeout; don't block redirect
    const client_id = await postToN8NFireAndForget({
      url: ONBOARD_URL,
      headers,
      body: bodyForm,
      timeoutMs: 2500,
    }).catch((e) => {
      // ✅ ADD THIS - Log n8n onboarding failure (fire and forget)
      errlog({
        shop,
        route: '/shopify-callback',
        status: 500,
        message: 'Failed to notify n8n of onboarding',
        detail: e?.message || String(e),
        request_id,
        code: 'E_N8N_ONBOARDING'
      }).catch(() => {}); // Fire and forget
      return "";
    });

    // Redirect to Connect with installed=1 (and client_id if available)
    const qp = new URLSearchParams({ shop, installed: "1" });
    if (client_id) qp.set("client_id", client_id);

    return {
      statusCode: 302,
      headers: {
        Location: `https://seoboss.com/pages/connect?${qp.toString()}`,
        // clear any state cookie we might have set
        "Set-Cookie":
          "shopify_oauth_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
      },
      body: "",
    };
    
  } catch (e) {
    // ✅ REPLACE OLD LOGGING - Use new errlog
    await errlog({
      shop,
      route: '/shopify-callback',
      status: e?.status || 500,
      message: 'Uncaught exception in OAuth callback',
      detail: e.stack || e?.message || String(e),
      request_id,
      code: 'E_EXCEPTION'
    }).catch(() => {}); // Fire and forget - don't block redirect
    
    return {
      statusCode: 302,
      headers: {
        Location: `https://seoboss.com/pages/connect?shop=${encodeURIComponent(shop || "")}&installed=1`,
      },
      body: "",
    };
  }
};
