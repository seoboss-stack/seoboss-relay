// netlify/functions/shopify-callback.mjs
import crypto from "node:crypto";

/**
 * ENV you must set in Netlify:
 * - SHOPIFY_API_KEY
 * - SHOPIFY_API_SECRET
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_KEY
 * - N8N_TOKEN_KEY_BASE64           (32-byte key, base64-encoded)
 * - FORWARD_SECRET                 (shared with n8n)
 * - N8N_ENGINE_BASE_URL            (e.g. https://blogengine.ngrok.app/webhook/seoboss)
 * - CALLBACK_REDIRECT (optional)   (where to send the merchant after success; defaults to a small "you can close this" page)
 * - SKIP_STATE_CHECK=true (optional for local dev)
 */

// ---- helpers ---------------------------------------------------------------

const normShop = (s = "") =>
  String(s)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/.*/, "")
    .replace(/:\d+$/, "")
    .replace(/\.shopify\.com$/i, ".myshopify.com");

function isValidShop(myshop) {
  return /^[a-z0-9][a-z0-9\-]*\.myshopify\.com$/i.test(myshop);
}

// RFC3986 encoder Shopify expects when building the message for HMAC check
const encodeRFC3986 = (str) =>
  encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function buildHmacMessage(url) {
  // Copy all params except hmac & signature; sort by key; join "k=v" with "&"
  const qp = new URLSearchParams(url.search);
  qp.delete("hmac");
  qp.delete("signature");

  const entries = Array.from(qp.entries())
    .map(([k, v]) => [k, v])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeRFC3986(k)}=${encodeRFC3986(v)}`);

  return entries.join("&");
}

function timingSafeEq(a, b) {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function json(status, data) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: typeof data === "string" ? data : JSON.stringify(data),
  };
}

function html(status, markup) {
  return {
    statusCode: status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: markup,
  };
}

// ---- main -----------------------------------------------------------------

export const handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") return json(405, "GET only");
    const url = new URL(event.rawUrl);

    const shopRaw = url.searchParams.get("shop") || "";
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const hmac = (url.searchParams.get("hmac") || "").trim();

    const shop = normShop(shopRaw);
    if (!isValidShop(shop)) return json(400, { error: "invalid shop domain", shop });

    if (!code || !hmac) return json(400, { error: "missing code or hmac" });

    // (1) Verify state (nonce) against a cookie set during /shopify-install
    if (!process.env.SKIP_STATE_CHECK) {
      const cookieHdr = event.headers?.cookie || event.headers?.Cookie || "";
      const cookies = Object.fromEntries(
        cookieHdr
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((kv) => {
            const i = kv.indexOf("=");
            return [kv.slice(0, i), decodeURIComponent(kv.slice(i + 1))];
          })
      );
      const expectedState = cookies["sb_state"] || "";
      if (!expectedState || expectedState !== state) {
        return json(401, { error: "bad state" });
      }
    }

    // (2) Verify HMAC from Shopify
    const message = buildHmacMessage(url);
    const digest = crypto.createHmac("sha256", process.env.SHOPIFY_API_SECRET).update(message, "utf8").digest("hex");
    if (!timingSafeEq(digest, hmac)) {
      return json(401, { error: "bad hmac" });
    }

    // (3) Exchange code -> Admin access token
    const tokenResp = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code,
      }),
    });

    if (!tokenResp.ok) {
      const t = await tokenResp.text();
      return json(tokenResp.status, { error: "token_exchange_failed", text: t });
    }

    const tokenData = await tokenResp.json(); // { access_token, scope, ... }
    const accessToken = tokenData.access_token;
    if (!accessToken) return json(500, { error: "no_access_token" });

    // (4) Encrypt token (AES-256-GCM)
    const kB64 = process.env.N8N_TOKEN_KEY_BASE64 || "";
    const key = Buffer.from(kB64, "base64");
    if (key.length !== 32) return json(500, { error: "bad N8N_TOKEN_KEY_BASE64 length (need 32-byte base64)" });

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(accessToken, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const packed = Buffer.concat([ct, tag]); // store as ciphertext|tag

    const iv_b64 = iv.toString("base64");
    const token_b64 = packed.toString("base64");

    // (5) Upsert to Supabase
    const supaUrl = process.env.SUPABASE_URL;
    const supaKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supaUrl || !supaKey) return json(500, { error: "missing supabase env" });

    // Table schema expected by your get-shop-token.mjs:
    // encrypted_shop_tokens(shop text primary key, token_b64 text, iv_b64 text)
    const upsertResp = await fetch(`${supaUrl}/rest/v1/encrypted_shop_tokens`, {
      method: "POST",
      headers: {
        apikey: supaKey,
        Authorization: `Bearer ${supaKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify([{ shop, token_b64, iv_b64 }]),
    });

    if (!upsertResp.ok) {
      const t = await upsertResp.text();
      return json(upsertResp.status, { error: "supabase_upsert_failed", text: t });
    }

   // (6) Kick onboarding into n8n with rich context (no token sent)
try {
  // deterministic client_id from shop
  const sub  = shop.replace(/\.myshopify\.com$/i, "");
  const slug = sub.replace(/[^a-z0-9]+/gi, "_").toLowerCase().replace(/^_+|_+$/g, "");
  const hash = crypto.createHash("sha1").update(shop).digest("hex").slice(0, 6);
  const client_id = `cli_${slug}_${hash}`;

  // (optional) cache the mapping in Supabase
  try {
    const supaUrl = process.env.SUPABASE_URL;
    const supaKey = process.env.SUPABASE_SERVICE_KEY;
    if (supaUrl && supaKey) {
      await fetch(`${supaUrl}/rest/v1/clients`, {
        method: "POST",
        headers: {
          apikey: supaKey,
          Authorization: `Bearer ${supaKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates"
        },
        body: JSON.stringify([{ client_id, shop }])
      }).catch(() => {});
    }
  } catch {}

  const base = (process.env.N8N_ENGINE_BASE_URL || "").replace(/\/$/, "");
  if (base) {
    const site_url = `https://${shop}`;

    // collect optional onboarding fields if you have them available here
    const contact_email     = (shopInfo?.email) || "";   // e.g., if you fetched shop info
    const default_language  = "en";
    const tone              = ""; // fill if captured earlier
    const target_audience   = "";
    const niche             = "";
    const seed_keywords     = "";
    const shop_input        = "";
    const plan              = ""; // "starter"|"pro"|"elite" etc.

    const payload = {
  shop,
  site_url,
  client_id,
  contact_email,
  default_language,
  tone,
  target_audience,
  niche,
  seed_keywords,
  shop_input,
  plan,
  admin_token: accessToken   // <-- only if you really want to send it
};


    // optional HMAC of body for extra integrity
    let hmac = "";
    try {
      const keyB64 = process.env.N8N_TOKEN_KEY_BASE64 || "";
      if (keyB64) {
        const key = Buffer.from(keyB64, "base64");
        hmac = crypto.createHmac("sha256", key).update(JSON.stringify(payload), "utf8").digest("hex");
      }
    } catch {}

    await fetch(`${base}/api/onboarding/submit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || "",
        "X-Seoboss-Ts": String(Math.floor(Date.now() / 1000)),
        "X-Seoboss-Key-Id": "global",
        ...(hmac ? { "X-Seoboss-Hmac": hmac } : {})
      },
      body: JSON.stringify(payload)
    }).catch(() => {});
  }
} catch {}


    // (6) Optional: kick the initial import through n8n
    try {
      const base = (process.env.N8N_ENGINE_BASE_URL || "").replace(/\/$/, "");
      if (base) {
        await fetch(`${base}/api/shop/import-articles`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || "",
            "X-Seoboss-Ts": String(Math.floor(Date.now() / 1000)),
          },
          body: JSON.stringify({ shop }),
        }).catch(() => {});
      }
    } catch {}

    // (7) Redirect back to your app UI in Admin (or show a friendly "done" page)
    const redirectTo = process.env.CALLBACK_REDIRECT; // e.g. https://hooks.seoboss.com/admin/index.html?shop=...
    if (redirectTo) {
      return {
        statusCode: 302,
        headers: { Location: `${redirectTo}${redirectTo.includes("?") ? "&" : "?"}shop=${encodeURIComponent(shop)}` },
        body: "",
      };
    }

    // Default: minimal "connected" page that merchants can close
    return html(
      200,
      `<!doctype html><meta charset="utf-8"><title>Connected</title>
       <body style="font-family:system-ui;background:#0b0f14;color:#e8fff6;display:grid;place-items:center;height:100vh">
       <div style="text-align:center;max-width:560px">
         <h1 style="color:#42ffd2">SEOBoss connected</h1>
         <p>Shop: <b>${shop}</b></p>
         <p>You can close this tab and return to the app.</p>
       </div></body>`
    );
  } catch (e) {
    return json(500, { error: e?.message || String(e) });
  }
};
