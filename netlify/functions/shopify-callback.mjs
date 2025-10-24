// netlify/functions/shopify-callback.mjs
import crypto from "node:crypto";
import { errlog } from './_lib/_errlog.mjs';

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

// ---------- handler ----------
export const handler = async (event) => {
  const request_id = event.headers?.["x-nf-request-id"] || event.headers?.["x-request-id"] || "";
  let shop = "";

  try {
    const API_KEY = process.env.SHOPIFY_API_KEY_PUBLIC || process.env.SHOPIFY_API_KEY || "";
    const SECRET = process.env.SHOPIFY_APP_SECRET_PUBLIC || process.env.SHOPIFY_APP_SECRET || "";

    if (!API_KEY || !SECRET) {
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

    const url = new URL(event.rawUrl);
    const q = Object.fromEntries(url.searchParams.entries());
    const { shop: rawShop, hmac, code, state, timestamp } = q;
    const host = q.host || ''; // carry Admin host through to final redirect

    // Validate shop + state
    shop = normShop(rawShop);
    const shopRe = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
    if (!shopRe.test(shop || "")) return { statusCode: 400, body: "invalid shop" };

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
    console.log('[CALLBACK] Exchanging OAuth code for access token...');
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: API_KEY, client_secret: SECRET, code }),
    });

    if (!tokenRes.ok) {
      const errTxt = await tokenRes.text();
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

    const { access_token } = await tokenRes.json();
    console.log('[CALLBACK] Got access token, storing in vault...');

    // Store token securely in vault (for future use)
    try {
      await storeTokenVault({ shop, access_token });
    } catch (e) {
      await errlog({
        shop,
        route: '/shopify-callback',
        status: 500,
        message: 'Failed to store access token in vault',
        detail: e?.message || String(e),
        request_id,
        code: 'E_TOKEN_STORAGE'
      }).catch(() => {});
      // Don't fail the flow - we can still pass token via cookie
    }

    // Register app/uninstalled webhook
    console.log('[CALLBACK] Registering webhooks...');
    try {
      await registerWebhooks({ shop, access_token, baseUrl: publicBaseUrl(event) });
    } catch (e) {
      await errlog({
        shop,
        route: '/shopify-callback',
        status: 500,
        message: 'Failed to register webhooks',
        detail: e?.message || String(e),
        request_id,
        code: 'E_WEBHOOK_REGISTRATION'
      }).catch(() => {});
      // Don't fail the flow
    }

    console.log('[CALLBACK] OAuth complete! Redirecting to admin page with token cookie...');

    // === REDIRECT TO ADMIN with token in cookie ===
    // NOTE: We do NOT call n8n here - the admin form will do that when user submits!
    const adminQs = new URLSearchParams({ shop });
    if (host) adminQs.set('host', host);
    
    return {
      statusCode: 302,
      headers: {
        Location: `https://hooks.seoboss.com/admin?${adminQs.toString()}`,
        // Set cookies: clear OAuth state, set token cookie
        "Set-Cookie": [
          "shopify_oauth_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
          // Token cookie: 10 min expiry, SameSite=None for iframe compatibility
          `shop_token=${access_token}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=None`
        ].join(', ')
      },
      body: "",
    };

  } catch (e) {
    // On error, still try to land in embedded Admin (without token)
    let host = "";
    try { host = new URL(event.rawUrl).searchParams.get("host") || ""; } catch {}
    
    console.error('[CALLBACK] Uncaught exception:', e);
    
    await errlog({
      shop,
      route: '/shopify-callback',
      status: e?.status || 500,
      message: 'Uncaught exception in OAuth callback',
      detail: e.stack || e?.message || String(e),
      request_id,
      code: 'E_EXCEPTION'
    }).catch(() => {});
    
    return {
      statusCode: 302,
      headers: {
        Location: `https://hooks.seoboss.com/admin?shop=${encodeURIComponent(shop || "")}${host ? `&host=${encodeURIComponent(host)}` : ""}`,
      },
      body: "",
    };
  }
};
