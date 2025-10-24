// netlify/functions/import-articles.mjs
import crypto from "node:crypto";
import { errlog } from "./_lib/_errlog.mjs";

// ---------- helpers ----------
function canonicalForm(obj){
  return Object.entries(obj||{})
    .filter(([,v]) => v !== undefined && v !== null && String(v).trim() !== "")
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v)))
    .join("&");
}
function normShop(s=''){
  return String(s||"").trim().toLowerCase()
    .replace(/^https?:\/\//,'').replace(/[?#].*$/,'').replace(/\/.*/,'')
    .replace(/:\d+$/,'').replace(/\.shopify\.com$/i,'.myshopify.com');
}
function readBearer(event){
  const h = event.headers || {};
  const v = h.authorization || h.Authorization || "";
  const m = /^Bearer\s+(.+)$/.exec(v);
  return m ? m[1] : "";
}
function b64url(s=''){ return Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8'); }
function decodeShopifyJWT(jwt){
  const parts = String(jwt||"").split(".");
  if (parts.length < 2) throw new Error("bad_session_token");
  const payload = JSON.parse(b64url(parts[1]));
  const dest = String(payload.dest || "").replace(/^https?:\/\//,'').toLowerCase();
  if (!dest || !/\.myshopify\.com$/i.test(dest)) throw new Error("bad_dest");
  return { shop: dest, payload };
}

const STATIC_ALLOW = new Set([
  "https://seoboss.com",
  "https://hooks.seoboss.com",
  "https://admin.shopify.com",
]);
function isAllowedOrigin(origin=''){
  try {
    if (!origin) return false;
    if (STATIC_ALLOW.has(origin)) return true;
    const u = new URL(origin);
    return u.hostname.endsWith(".myshopify.com"); // theme editor/storefronts
  } catch { return false; }
}
function cors(origin){
  const allow = isAllowedOrigin(origin) ? origin : "https://seoboss.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
}

// ---------- handler ----------
export const handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || "";
  const request_id = event.headers?.["x-request-id"] || event.headers?.["X-Request-Id"] || "";

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(origin), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors(origin), body: "POST only" };
  }

  const FWD_SECRET = process.env.FORWARD_SECRET || "";
  const PUBLIC_HMAC_KEY = process.env.PUBLIC_HMAC_KEY || "";
  const N8N_IMPORT_URL = process.env.N8N_IMPORT_ARTICLES_URL; // https://.../webhook/seoboss/api/shop/import-articles

  if (!FWD_SECRET || !PUBLIC_HMAC_KEY || !N8N_IMPORT_URL) {
    await errlog({
      shop: '',
      route: '/import-articles',
      status: 500,
      message: 'Import articles configuration missing',
      detail: `FWD_SECRET:${!!FWD_SECRET} HMAC_KEY:${!!PUBLIC_HMAC_KEY} N8N_URL:${!!N8N_IMPORT_URL}`,
      request_id,
      code: 'E_CONFIG'
    }).catch(()=>{});
    return { statusCode: 500, headers: cors(origin), body: "missing env FORWARD_SECRET/PUBLIC_HMAC_KEY/N8N_IMPORT_ARTICLES_URL" };
  }

  try {
    // Accept JSON or form data
    const ct = (event.headers["content-type"] || event.headers["Content-Type"] || "").toLowerCase();
    let client_id = "";
    let shopFromBody = "";
    if (ct.includes("application/json")) {
      const b = JSON.parse(event.body || "{}");
      client_id = String(b.client_id || "").trim();
      shopFromBody = String(b.shop || "").trim().toLowerCase();
    } else {
      const params = new URLSearchParams(event.body || "");
      client_id = String(params.get("client_id") || "").trim();
      shopFromBody = String(params.get("shop") || "").trim().toLowerCase();
    }

    // Derive shop from Shopify session token when embedded (authoritative)
    let shop = normShop(shopFromBody);
    const bearer = readBearer(event);
    if (bearer) {
      try { shop = decodeShopifyJWT(bearer).shop; } catch { /* fallback to body */ }
    }
    if (!shop) {
      return { statusCode: 400, headers: cors(origin), body: JSON.stringify({ ok:false, message:"missing shop" }) };
    }

    // Build the canonical body we will sign & forward
    const forwardBody = canonicalForm({ client_id, shop });
    const ts = Math.floor(Date.now()/1000).toString();
    const sig = crypto.createHmac("sha256", PUBLIC_HMAC_KEY).update(forwardBody + "\n" + ts).digest("hex");

    let rsp;
    try {
      rsp = await fetch(N8N_IMPORT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
          "X-Seoboss-Ts": ts,
          "X-Seoboss-Hmac": sig,
          "X-Seoboss-Key-Id": "global",
          "X-SEOBOSS-FORWARD-SECRET": FWD_SECRET,
          "X-Request-Id": request_id
        },
        body: forwardBody
      });
    } catch (err) {
      await errlog({
        shop,
        route: '/import-articles',
        status: 500,
        message: 'Failed to reach n8n import endpoint',
        detail: `client_id:${client_id} shop:${shop} error:${err.message}`,
        request_id,
        code: 'E_N8N_UNREACHABLE',
        client_id
      }).catch(()=>{});
      throw err;
    }

    if (!rsp.ok) {
      const errorText = await rsp.clone().text();
      await errlog({
        shop,
        route: '/import-articles',
        status: rsp.status,
        message: 'n8n import endpoint returned error',
        detail: errorText.slice(0, 500),
        request_id,
        code: 'E_N8N_FAILED',
        client_id
      }).catch(()=>{});
    }

    const text = await rsp.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw:text }; }

    return {
      statusCode: 200,
      headers: { ...cors(origin), "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: rsp.ok,
        // keep the old shape if your UI expects more fields later:
        imported: data?.imported ?? data?.stats?.imported ?? null,
        deduped: data?.deduped ?? data?.stats?.deduped ?? null,
        sheet_url: data?.sheet_url || null,
        sample: Array.isArray(data?.sample) ? data.sample : undefined,
        stats: data?.stats || null
      })
    };

  } catch (e) {
    const shopGuess = normShop((() => {
      try {
        if ((event.headers["content-type"] || "").includes("application/json")) {
          return JSON.parse(event.body || "{}")?.shop || "";
        }
        return new URLSearchParams(event.body || "").get("shop") || "";
      } catch { return ""; }
    })());
    await errlog({
      shop: shopGuess,
      route: '/import-articles',
      status: 500,
      message: 'Uncaught exception in import-articles',
      detail: e.stack || e.message || String(e),
      request_id,
      code: 'E_EXCEPTION',
    }).catch(()=>{});
    return {
      statusCode: 500,
      headers: { ...cors(origin), "Content-Type": "application/json" },
      body: JSON.stringify({ ok:false, message: String(e?.message||e) })
    };
  }
};
