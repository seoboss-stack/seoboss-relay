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

// Fire n8n with LONGER timeout and capture activation_token
async function postToN8N({ url, headers, body, timeoutMs = 10000 }) {
  let result = { client_id: "", activation_token: "" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    
    clearTimeout(timer);
    
    if (res && res.ok) {
      try {
        const data = await res.json();
        console.log('[CALLBACK] n8n response:', JSON.stringify(data).slice(0, 200));
        result.client_id = data?.client_id || data?.clientId || "";
        result.activation_token = data?.activation_token || data?.activationToken || "";
      } catch (e) {
        console.error('[CALLBACK] Failed to parse n8n response:', e.message);
      }
    } else {
      console.error('[CALLBACK] n8n returned non-OK:', res?.status, await res?.text().catch(() => ''));
    }
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      console.error('[CALLBACK] n8n request timed out after', timeoutMs, 'ms');
    } else {
      console.error('[CALLBACK] n8n request failed:', e.message);
    }
  }
  
  return result;
}

// ---------- handler ----------
export const handler = async (event) => {
  const request_id = event.headers?.["x-nf-request-id"] || event.headers?.["x-request-id"] || "";
  let shop = "";

  try {
    const API_KEY = process.env.SHOPIFY_API_KEY_PUBLIC || process.env.SHOPIFY_API_KEY || "";
    const SECRET = process.env.SHOPIFY_APP_SECRET_PUBLIC || process.env.SHOPIFY_APP_SECRET || "";
    const ONBOARD_URL = process.env.N8N_ONBOARD_SUBMIT_URL;
    const PUBLIC_HMAC_KEY = process.env.PUBLIC_HMAC_KEY || "";
    const FWD_SECRET = process.env.FORWARD_SECRET || "";

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

    if (!ONBOARD_URL) {
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

    // Store token securely (vault)
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
    }

    // Prepare one-time onboarding POST to n8n
    console.log('[CALLBACK] Calling n8n to create pending account...');
    const bodyForm = new URLSearchParams({
      client_name: "",
      contact_email: "",
      default_language: "en",
      shop_input: shop, // Full URL: "seoboss-engine.myshopify.com"
      admin_token: access_token,
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
      "X-Request-Id": request_id,
    };
    if (PUBLIC_HMAC_KEY) {
      const sig = crypto.createHmac("sha256", PUBLIC_HMAC_KEY).update(bodyForm + "\n" + ts2).digest("hex");
      headers["X-Seoboss-Hmac"] = sig;
    }

    // Call n8n with 10 second timeout and capture BOTH client_id and activation_token
    const { client_id, activation_token } = await postToN8N({
      url: ONBOARD_URL,
      headers,
      body: bodyForm,
      timeoutMs: 10000, // 10 seconds - give n8n time to set up everything
    });

    console.log('[CALLBACK] n8n returned client_id:', client_id, 'activation_token:', activation_token);

    if (!client_id || !activation_token) {
      console.warn('[CALLBACK] WARNING: Missing client_id or activation_token from n8n!');
      await errlog({
        shop,
        route: '/shopify-callback',
        status: 500,
        message: 'n8n did not return required fields',
        detail: `client_id: ${client_id}, activation_token: ${activation_token}`,
        request_id,
        code: 'E_N8N_INCOMPLETE'
      }).catch(() => {});
    }

    // === FINAL REDIRECT → embedded Admin with activation data ===
    const adminQs = new URLSearchParams({ shop });
    if (host) adminQs.set('host', host);
    if (client_id) adminQs.set('client_id', client_id);
    if (activation_token) adminQs.set('activation_token', activation_token);
    
    console.log('[CALLBACK] Redirecting to admin with params:', adminQs.toString());
    
    return {
      statusCode: 302,
      headers: {
        Location: `https://hooks.seoboss.com/admin?${adminQs.toString()}`,
        "Set-Cookie": "shopify_oauth_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
      },
      body: "",
    };

  } catch (e) {
    // On error, still try to land in embedded Admin
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
