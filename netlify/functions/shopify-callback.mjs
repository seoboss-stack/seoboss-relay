// netlify/functions/shopify-callback.mjs
import crypto from "node:crypto";

/**
 * Required ENV:
 * - SHOPIFY_API_KEY            (or SHOPIFY_API_KEY_PUBLIC)
 * - SHOPIFY_APP_SECRET         (or SHOPIFY_APP_SECRET_PUBLIC)
 * - FORWARD_SECRET             (shared secret for your backend/n8n)
 * - APP_URL or PUBLIC_BASE_URL (e.g. https://hooks.seoboss.com)
 *
 * Optional ENV:
 * - N8N_ONBOARD_SUBMIT_URL     (POST target to begin onboarding)
 * - PUBLIC_HMAC_KEY            (if you want to HMAC-sign n8n body)
 */

const getEnv = (k, alt) => process.env[k] || (alt ? process.env[alt] : "") || "";
const APP_BASE = (getEnv("PUBLIC_BASE_URL") || getEnv("APP_URL") || "https://hooks.seoboss.com").replace(/\/$/, "");
const API_KEY = getEnv("SHOPIFY_API_KEY", "SHOPIFY_API_KEY_PUBLIC");
const SECRET  = getEnv("SHOPIFY_APP_SECRET", "SHOPIFY_APP_SECRET_PUBLIC");
const N8N_URL = getEnv("N8N_ONBOARD_SUBMIT_URL");
const FWD_SECRET = getEnv("FORWARD_SECRET") || "";
const PUBLIC_HMAC_KEY = getEnv("PUBLIC_HMAC_KEY") || "";

// ---------- helpers ----------
const normShop = (s = "") =>
  String(s)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/.*/, "")
    .replace(/:\d+$/, "")
    .replace(/\.shopify\.com$/i, ".myshopify.com");

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

async function registerWebhooks({ shop, access_token, baseUrl }) {
  const apiBase = `https://${shop}/admin/api/2024-10`;
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": access_token,
  };

  // Add more topics later if needed
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

async function storeTokenVault({ shop, access_token }) {
  const url = `${APP_BASE}/.netlify/functions/store-shop-token`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SEOBOSS-FORWARD-SECRET": FWD_SECRET,
    },
    body: JSON.stringify({ shop, token: access_token }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`store-shop-token failed: ${res.status} ${txt}`);
  }
}

// Fire n8n quickly; do not block redirect
async function postToN8NFireAndForget({ url, headers, body, timeoutMs = 2500 }) {
  if (!url) return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    if (r && r.ok) {
      try {
        const data = await r.json().catch(() => ({}));
        return data?.client_id || data?.clientId || "";
      } catch {}
    }
    return "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function json(status, data) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: typeof data === "string" ? data : JSON.stringify(data),
  };
}

// ---------- handler ----------
export const handler = async (event) => {
  let shop = "";
  try {
    if (!API_KEY || !SECRET) return json(500, { error: "missing API key/secret" });

    const url = new URL(event.rawUrl);
    const q = Object.fromEntries(url.searchParams.entries());
    const { hmac, code, state, timestamp } = q;
    const host = q.host || ""; // Admin host to keep embedded happy
    shop = normShop(q.shop || "");

    // 1) Validate shop
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
      return json(400, { error: "invalid shop domain", shop });
    }

    // 2) Validate state only if we previously set the cookie (prevents false 401s)
    const cookies = parseCookies(event.headers?.cookie || event.headers?.Cookie || "");
    if (state && cookies.shopify_oauth_state && cookies.shopify_oauth_state !== state) {
      return json(401, { error: "bad state" });
    }

    // 3) Anti-replay + HMAC
    const ts = Number(timestamp || 0);
    if (!ts || Math.abs(Date.now() / 1000 - ts) > 600) return json(401, { error: "stale oauth" });
    if (!hmac || !code) return json(400, { error: "missing params" });

    const message = Object.keys(q)
      .filter((k) => k !== "hmac" && k !== "signature")
      .sort()
      .map((k) => `${k}=${q[k]}`)
      .join("&");
    const digest = crypto.createHmac("sha256", SECRET).update(message).digest("hex");
    const safe =
      hmac.length === digest.length &&
      crypto.timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(digest, "hex"));
    if (!safe) return json(401, { error: "invalid hmac" });

    // 4) Exchange code → offline access token
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: API_KEY, client_secret: SECRET, code }),
    });
    if (!tokenRes.ok) {
      const errTxt = await tokenRes.text().catch(() => "");
      return json(502, { error: "token_exchange_failed", text: errTxt });
    }
    const { access_token } = await tokenRes.json();
    if (!access_token) return json(502, { error: "no_access_token" });

    // 5) Store token securely
    try { await storeTokenVault({ shop, access_token }); } catch {}

    // 6) Register required webhooks
    try { await registerWebhooks({ shop, access_token, baseUrl: APP_BASE }); } catch {}

    // 7) Kick onboarding in n8n (fire-and-forget, short timeout)
    let client_id = "";
    try {
      if (N8N_URL) {
        const bodyForm = new URLSearchParams({
          client_name: "",
          contact_email: "",
          default_language: "en",
          shop_input: shop,
          admin_token: access_token, // TODO: migrate to vault-fetch on n8n side
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
        };
        if (PUBLIC_HMAC_KEY) {
          const sig = crypto.createHmac("sha256", PUBLIC_HMAC_KEY).update(bodyForm + "\n" + ts2).digest("hex");
          headers["X-Seoboss-Hmac"] = sig;
        }
        client_id = await postToN8NFireAndForget({
          url: N8N_URL,
          headers,
          body: bodyForm,
          timeoutMs: 2500,
        });
      }
    } catch {}

    // 8) Final redirect → embedded Admin
    const admin = new URL(`${APP_BASE}/admin`);
    admin.searchParams.set("shop", shop);
    if (host) admin.searchParams.set("host", host);
    admin.searchParams.set("installed", "1");
    if (client_id) admin.searchParams.set("client_id", client_id);

    return {
      statusCode: 302,
      headers: {
        Location: admin.toString(),
        "Set-Cookie": "shopify_oauth_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
      },
      body: "",
    };
  } catch (e) {
    // On error, still try to land in embedded Admin (best-effort)
    const fallback = new URL(`${APP_BASE}/admin`);
    if (shop) fallback.searchParams.set("shop", shop);
    const host = (() => { try { return new URL(event.rawUrl).searchParams.get("host") || ""; } catch { return ""; } })();
    if (host) fallback.searchParams.set("host", host);
    fallback.searchParams.set("installed", "1");
    return {
      statusCode: 302,
      headers: { Location: fallback.toString() },
      body: "",
    };
  }
};
