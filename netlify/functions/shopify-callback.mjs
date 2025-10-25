// netlify/functions/shopify-callback.mjs
import crypto from "node:crypto";

/** ENV you should set (exact names) */
const APP_BASE  = (process.env.PUBLIC_BASE_URL || process.env.APP_URL || "https://hooks.seoboss.com").replace(/\/$/, "");
const API_KEY = process.env.SHOPIFY_API_KEY_PUBLIC || process.env.SHOPIFY_API_KEY || "";
const SECRET = process.env.SHOPIFY_APP_SECRET_PUBLIC || process.env.SHOPIFY_APP_SECRET || "";
const ONBOARD_URL = process.env.N8N_ONBOARD_SUBMIT_URL; // https://.../webhook/seoboss/api/onboarding/submit
const PUBLIC_HMAC_KEY = process.env.PUBLIC_HMAC_KEY || "";
const FWD_SECRET = process.env.FORWARD_SECRET || "";


/* ---------- helpers ---------- */

// RFC3986 encoder (Shopify expects this when constructing the HMAC message)
const encodeRFC3986 = (str) =>
  encodeURIComponent(str).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Build the exact message Shopify signs: all params except hmac/signature, ASCII sort, RFC3986 k=v joined by &
function buildHmacMessage(url) {
  const qp = new URLSearchParams(url.search);
  qp.delete("hmac");
  qp.delete("signature");
  const entries = Array.from(qp.entries())
    .map(([k, v]) => [k, v])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeRFC3986(k)}=${encodeRFC3986(v)}`);
  return entries.join("&");
}

const normShop = (s = "") =>
  String(s).trim().toLowerCase()
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
      .map(c => {
        const i = c.indexOf("=");
        if (i === -1) return [c, ""];
        return [c.slice(0, i).trim(), decodeURIComponent(c.slice(1 + i))];
      })
  );
}

async function registerWebhooks({ shop, access_token, baseUrl }) {
  const apiBase = `https://${shop}/admin/api/2024-10`;
  const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": access_token };
  const targets = [{ topic: "app/uninstalled", address: `${baseUrl}/.netlify/functions/uninstalled` }];

  const listRes = await fetch(`${apiBase}/webhooks.json`, { headers });
  if (!listRes.ok) throw new Error(`list webhooks: ${listRes.status} ${await listRes.text()}`);
  const existing = (await listRes.json())?.webhooks || [];

  for (const { topic, address } of targets) {
    if (existing.some(w => w.topic === topic && w.address === address)) continue;
    const create = await fetch(`${apiBase}/webhooks.json`, {
      method: "POST", headers, body: JSON.stringify({ webhook: { topic, address, format: "json" } }),
    });
    if (!create.ok) throw new Error(`create ${topic}: ${create.status} ${await create.text()}`);
  }
}

async function storeTokenVault({ shop, access_token }) {
  const url = `${APP_BASE}/.netlify/functions/store-shop-token`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SEOBOSS-FORWARD-SECRET": FWD_SECRET },
    body: JSON.stringify({ shop, token: access_token }),
  });
  if (!res.ok) throw new Error(`store-shop-token failed: ${res.status} ${await res.text().catch(() => "")}`);
}

async function postToN8NFireAndForget({ url, headers, body, timeoutMs = 2500 }) {
  if (!url) return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    if (r && r.ok) {
      try { const data = await r.json().catch(() => ({})); return data?.client_id || data?.clientId || ""; }
      catch {}
    }
    return "";
  } catch {
    return "";
  } finally { clearTimeout(timer); }
}

function json(status, data) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
}

/* ---------- handler ---------- */
export const handler = async (event) => {
  let shop = "";
  try {
    if (!API_KEY || !SECRET) return json(500, { error: "missing API key/secret" });

    // Use the raw URL exactly as received (critical for HMAC)
    const url = new URL(event.rawUrl);
    const q   = Object.fromEntries(url.searchParams.entries());
    const hmac = (q.hmac || "").trim();
    const code = q.code || "";
    const state = q.state || "";
    const timestamp = Number(q.timestamp || 0);
    const host = q.host || "";
    shop = normShop(q.shop || "");

    // Basic checks
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) return json(400, { error: "invalid shop domain", shop });
    if (!code || !hmac) return json(400, { error: "missing code or hmac" });
    if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > 600) return json(401, { error: "stale oauth" });

    // State check only if we set it (prevents false 401s)
    const cookies = parseCookies(event.headers?.cookie || event.headers?.Cookie || "");
    if (state && cookies.shopify_oauth_state && cookies.shopify_oauth_state !== state) {
      return json(401, { error: "bad state" });
    }

    // HMAC verify (RFC3986 + sorted keys)
    const message = buildHmacMessage(url);
    const digest  = crypto.createHmac("sha256", SECRET).update(message, "utf8").digest("hex");
    const ok =
      digest.length === hmac.length &&
      crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(hmac, "hex"));
    if (!ok) {
      // Minimal safe debug — lengths only
      console.error("[callback] invalid hmac", { msgLen: message.length, hLen: hmac.length, dLen: digest.length });
      return json(401, { error: "invalid hmac" });
    }

    // Token exchange
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: API_KEY, client_secret: SECRET, code }),
    });
    if (!tokenRes.ok) return json(tokenRes.status, { error: "token_exchange_failed", text: await tokenRes.text() });
    const { access_token } = await tokenRes.json();
    if (!access_token) return json(502, { error: "no_access_token" });

    // Store + webhooks (best effort)
    try { await storeTokenVault({ shop, access_token }); } catch {}
    try { await registerWebhooks({ shop, access_token, baseUrl: APP_BASE }); } catch {}

    // Kick onboarding (fire-and-forget)
    let client_id = "";
    if (N8N_URL) {
      const bodyForm = new URLSearchParams({
        client_name: "", contact_email: "", default_language: "en",
        shop_input: shop, admin_token: access_token, tone: "", niche: "", seed_keywords: "", target_audience: "",
      }).toString();
      const ts2 = String(Math.floor(Date.now() / 1000));
      const headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-SEOBOSS-FORWARD-SECRET": FWD_SECRET,
        "X-Seoboss-Ts": ts2,
        "X-Seoboss-Key-Id": "global",
        ...(PUBLIC_HMAC_KEY ? { "X-Seoboss-Hmac": crypto.createHmac("sha256", PUBLIC_HMAC_KEY).update(bodyForm + "\n" + ts2).digest("hex") } : {}),
      };
      try { client_id = await postToN8NFireAndForget({ url: N8N_URL, headers, body: bodyForm, timeoutMs: 2500 }); } catch {}
    }

    // Final redirect to embedded admin
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
    // Best-effort land in admin even on errors
    const fallback = new URL(`${APP_BASE}/admin`);
    if (shop) fallback.searchParams.set("shop", shop);
    try {
      const host = new URL(event.rawUrl).searchParams.get("host") || "";
      if (host) fallback.searchParams.set("host", host);
    } catch {}
    fallback.searchParams.set("installed", "1");
    return { statusCode: 302, headers: { Location: fallback.toString() }, body: "" };
  }
};
