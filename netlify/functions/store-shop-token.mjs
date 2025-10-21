// netlify/functions/store-shop-token.mjs
import crypto from "node:crypto";
import { errlog } from './_lib/_errlog.mjs';  // ✅ REPLACE OLD IMPORT

const normShop = (s = "") =>
  String(s).trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/.*/, "")
    .replace(/:\d+$/, "")
    .replace(/\.shopify\.com$/i, ".myshopify.com");

export const handler = async (event) => {
  const request_id = event.headers?.["x-nf-request-id"] || event.headers?.["x-request-id"] || "";
  let shop = null, client_id = null;

  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "POST only" };
    }

    // Parse JSON body
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return { statusCode: 400, body: "invalid JSON" };
    }

    const { shop: rawShop, client_id: cid, token } = body || {};
    client_id = cid ?? null;
    shop = normShop(rawShop);

    if (!shop || !token) {
      return { statusCode: 400, body: "missing shop or token" };
    }

    // Env checks
    const keyB64 = process.env.N8N_TOKEN_KEY_BASE64 || "";
    const SUPABASE_URL = process.env.SUPABASE_URL || "";
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

    const key = Buffer.from(keyB64, "base64");
    if (key.length !== 32) {
      // ✅ ADD THIS - Log encryption key configuration error
      await errlog({
        shop,
        route: '/store-shop-token',
        status: 500,
        message: 'Encryption key not properly configured',
        detail: `Key length: ${key.length}, expected: 32`,
        request_id,
        code: 'E_CONFIG',
        client_id
      });
      return { statusCode: 500, body: "server not configured: bad N8N_TOKEN_KEY_BASE64" };
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      // ✅ ADD THIS - Log Supabase configuration error
      await errlog({
        shop,
        route: '/store-shop-token',
        status: 500,
        message: 'Supabase credentials not configured',
        detail: `URL present: ${!!SUPABASE_URL}, Key present: ${!!SUPABASE_SERVICE_KEY}`,
        request_id,
        code: 'E_CONFIG',
        client_id
      });
      return { statusCode: 500, body: "server not configured: missing Supabase env" };
    }

    // AES-256-GCM encrypt token
    let iv, cipher, enc, tag, token_b64, iv_b64;
    try {
      iv = crypto.randomBytes(12);
      cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      enc = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
      tag = cipher.getAuthTag();
      token_b64 = Buffer.concat([enc, tag]).toString("base64");
      iv_b64 = iv.toString("base64");
    } catch (err) {
      // ✅ ADD THIS - Log encryption failure
      await errlog({
        shop,
        route: '/store-shop-token',
        status: 500,
        message: 'Failed to encrypt token',
        detail: err.message || String(err),
        request_id,
        code: 'E_ENCRYPTION_FAILED',
        client_id
      });
      throw err;
    }

    // Upsert into Supabase (REST)
    const url = `${SUPABASE_URL}/rest/v1/encrypted_shop_tokens`;
    const payload = JSON.stringify([{ shop, client_id, token_b64, iv_b64 }]);

    const rsp = await fetch(url, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates"
      },
      body: payload
    });

    if (!rsp.ok) {
      const txt = await rsp.text();
      
      // ✅ ADD THIS - Log database write failure
      await errlog({
        shop,
        route: '/store-shop-token',
        status: rsp.status,
        message: 'Failed to store encrypted token in Supabase',
        detail: txt,
        request_id,
        code: 'E_DB_WRITE',
        client_id
      });
      
      // Throw to trigger logging below
      const err = new Error(`db write failed: ${txt}`);
      err.status = rsp.status;
      throw err;
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };

  } catch (e) {
    // ✅ REPLACE OLD LOGGING - Use new errlog
    await errlog({
      shop,
      route: '/store-shop-token',
      status: e?.status || 500,
      message: 'Uncaught exception in store-shop-token',
      detail: e.stack || e.message || String(e),
      request_id,
      code: 'E_EXCEPTION',
      client_id
    }).catch(() => {}); // Fire and forget - don't block response

    return { statusCode: 500, body: "internal error" };
  }
};
