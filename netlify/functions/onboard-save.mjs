// netlify/functions/onboard-save.mjs
import crypto from "node:crypto";

const json = (status, data) => ({
  statusCode: status,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",          // adjust if you want to pin it
    "Access-Control-Allow-Headers": "Content-Type,X-Seoboss-Ts,X-Seoboss-Hmac,X-Seoboss-Key-Id",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  },
  body: JSON.stringify(data),
});

const parseFormUrlEncoded = (raw = "") =>
  Object.fromEntries(
    (raw || "")
      .split("&")
      .filter(Boolean)
      .map(pair => {
        const [k, v = ""] = pair.split("=");
        return [decodeURIComponent(k.replace(/\+/g, "%20")), decodeURIComponent(v.replace(/\+/g, "%20"))];
      })
  );

// Normalize a shop to *.myshopify.com host
const normShop = (s = "") =>
  String(s).trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/.*/, "")
    .replace(/:\d+$/, "")
    .replace(/\.shopify\.com$/i, ".myshopify.com");

const timingSafeEq = (a, b) => {
  const A = Buffer.from(String(a), "utf8");
  const B = Buffer.from(String(b), "utf8");
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch { return false; }
};

// HMAC(message = "<urlencoded-body>\n<unix_ts>")
const verifyHmac = ({ body, ts, provided, key }) => {
  if (!key) return false;
  const msg = `${body}\n${ts}`;
  const digest = crypto.createHmac("sha256", key).update(msg, "utf8").digest("hex");
  return timingSafeEq(digest, provided || "");
};

// Simple, deterministic client_id from shop when missing
const clientIdFromShop = (shop) => {
  const base = String(shop || "").toLowerCase();
  if (!base) return "";
  // short stable hash
  const h = crypto.createHash("sha256").update(base).digest("hex").slice(0, 12);
  return `cli_${base.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}_${h}`;
};

export const handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "POST only" });
  }

  const PUBLIC_HMAC_KEY = process.env.PUBLIC_HMAC_KEY || "";          // <— set in Netlify
  const FORWARD_SECRET  = process.env.FORWARD_SECRET || "";           // <— set in Netlify
  const N8N_BASE        = (process.env.N8N_ENGINE_BASE_URL || "").replace(/\/$/, ""); // e.g. https://blogengine.ngrok.app/webhook/seoboss

  // Expect form-urlencoded (from your embedded admin script)
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");

  // Header auth (HMAC)
  const headers = event.headers || {};
  const tsHeader   = headers["x-seoboss-ts"] || headers["X-Seoboss-Ts"] || "";
  const hmacHeader = headers["x-seoboss-hmac"] || headers["X-Seoboss-Hmac"] || "";
  const keyId      = headers["x-seoboss-key-id"] || headers["X-Seoboss-Key-Id"] || "global";

  // 1) freshness (±5min)
  const ts = parseInt(tsHeader, 10);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) {
    return json(401, { ok: false, error: "stale_or_missing_timestamp" });
  }

  // 2) verify HMAC
  const good = verifyHmac({ body: rawBody, ts, provided: hmacHeader, key: PUBLIC_HMAC_KEY });
  if (!good) {
    return json(401, { ok: false, error: "bad_hmac" });
  }

  // 3) parse fields
  const form = parseFormUrlEncoded(rawBody);

  // Allowed fields (ignore anything else)
  const contact_email    = (form.contact_email || "").trim();
  const default_language = (form.default_language || "en").trim().toLowerCase();
  const tone             = (form.tone || "").trim();
  const niche            = (form.niche || "").trim();
  const seed_keywords    = (form.seed_keywords || "").trim();
  const target_audience  = (form.target_audience || "").trim();
  const default_blog_id  = (form.default_blog_id || "").trim();
  const client_id_in     = (form.client_id || "").trim();
  const shop_input       = normShop(form.shop || form.shop_input || "");

  if (!shop_input) return json(400, { ok: false, error: "missing_shop" });

  // 4) ensure client_id
  const client_id = client_id_in || clientIdFromShop(shop_input);

  // This is the payload you’ll save/forward
  const profile = {
    client_id,
    shop: shop_input,
    contact_email: contact_email || undefined,
    default_language,
    tone: tone || undefined,
    niche: niche || undefined,
    seed_keywords: seed_keywords || undefined,
    target_audience: target_audience || undefined,
    ...(default_blog_id ? { default_blog_id } : {}),
    idem: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    key_id: keyId,
  };

  // 5) Forward to n8n (optional but recommended) to persist/update profile
  let backend = null;
  if (N8N_BASE) {
    try {
      const url = `${N8N_BASE}/api/client/profile`;  // <- your n8n workflow webhook (adjust path if needed)
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SEOBOSS-FORWARD-SECRET": FORWARD_SECRET,
          "X-Seoboss-Ts": String(Math.floor(Date.now() / 1000)),
        },
        body: JSON.stringify(profile),
      });
      const text = await resp.text();
      try { backend = text ? JSON.parse(text) : {}; } catch { backend = { raw: text }; }
      if (!resp.ok) {
        return json(resp.status, { ok: false, error: "backend_error", details: backend });
      }
    } catch (e) {
      return json(502, { ok: false, error: "backend_unreachable", message: e?.message || String(e) });
    }
  }

  // 6) Compose the response
  const out = {
    ok: true,
    client_id,
    shop: shop_input,
    // Pass through helpful fields if your backend returned them
    default_blog_id: backend?.default_blog_id || default_blog_id || null,
    blogs_list: Array.isArray(backend?.blogs_list) ? backend.blogs_list : undefined,
    sheet_url: backend?.sheet_url || undefined,
    message: backend?.message || "Saved",
  };

  return json(200, out);
};
