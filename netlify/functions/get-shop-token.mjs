// netlify/functions/get-shop-token.mjs
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
  
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "POST only" };
    }

    // backend→backend auth
    const FWD = process.env.FORWARD_SECRET || "";
    const hdr = event.headers || {};
    const got = hdr["x-seoboss-forward-secret"] || hdr["X-Seoboss-Forward-Secret"];
    
    if (!FWD || got !== FWD) return { statusCode: 401, body: "forbidden" };

    const { client_id = "", shop: rawShop = "" } = JSON.parse(event.body || "{}");
    
    if (!client_id && !rawShop) return { statusCode: 400, body: "client_id or shop required" };

    const shop = rawShop ? normShop(rawShop) : "";
    const url   = process.env.SUPABASE_URL;
    const key   = process.env.SUPABASE_SERVICE_KEY;
    const keyB64 = process.env.N8N_TOKEN_KEY_BASE64;

    if (!url || !key || !keyB64) {
      // ✅ ADD THIS - Log missing environment variables
      await errlog({
        shop,
        route: '/get-shop-token',
        status: 500,
        message: 'Token decryption environment not configured',
        detail: `SUPABASE_URL: ${!!url}, SERVICE_KEY: ${!!key}, TOKEN_KEY: ${!!keyB64}`,
        request_id,
        code: 'E_CONFIG',
        client_id
      });
      return { statusCode: 500, body: "missing env" };
    }

    const filter = client_id
      ? `client_id=eq.${encodeURIComponent(client_id)}`
      : `shop=eq.${encodeURIComponent(shop)}`;

    // fetch encrypted row
    const rsp = await fetch(
      `${url}/rest/v1/encrypted_shop_tokens?select=shop,token_b64,iv_b64&${filter}&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );

    if (!rsp.ok) {
      const errorText = await rsp.text();
      
      // ✅ ADD THIS - Log Supabase fetch failure
      await errlog({
        shop,
        route: '/get-shop-token',
        status: rsp.status,
        message: 'Failed to fetch encrypted token from Supabase',
        detail: errorText,
        request_id,
        code: 'E_DB_READ',
        client_id
      });
      
      return { statusCode: rsp.status, body: errorText };
    }

    const [row] = await rsp.json();
    
    if (!row) {
      // ✅ ADD THIS - Log token not found (useful for debugging, not an error per se)
      // Only log if it seems unexpected (has client_id or specific shop)
      if (client_id || shop) {
        await errlog({
          shop,
          route: '/get-shop-token',
          status: 404,
          message: 'Shop token not found in vault',
          detail: `client_id: ${client_id}, shop: ${shop}`,
          request_id,
          code: 'E_TOKEN_NOT_FOUND',
          client_id
        }).catch(() => {}); // Fire and forget - 404s might be expected
      }
      
      return { statusCode: 404, body: "not found" };
    }

    // decrypt AES-256-GCM (ciphertext|tag)
    const k = Buffer.from(keyB64, "base64");
    
    if (k.length !== 32) {
      // ✅ ADD THIS - Log encryption key error
      await errlog({
        shop,
        route: '/get-shop-token',
        status: 500,
        message: 'Encryption key has invalid length',
        detail: `Expected 32 bytes, got ${k.length}`,
        request_id,
        code: 'E_CONFIG',
        client_id
      });
      return { statusCode: 500, body: "bad key length" };
    }

    try {
      const iv  = Buffer.from(row.iv_b64, "base64");
      const raw = Buffer.from(row.token_b64, "base64");
      
      if (raw.length < 17) {
        // ✅ ADD THIS - Log corrupted token data
        await errlog({
          shop: row.shop,
          route: '/get-shop-token',
          status: 500,
          message: 'Encrypted token data is corrupted',
          detail: `Token length: ${raw.length}, expected >= 17`,
          request_id,
          code: 'E_DECRYPTION_FAILED',
          client_id
        });
        return { statusCode: 500, body: "ciphertext too short" };
      }

      const tag = raw.subarray(raw.length - 16);
      const ct  = raw.subarray(0, raw.length - 16);
      const decipher = crypto.createDecipheriv("aes-256-gcm", k, iv);
      decipher.setAuthTag(tag);
      const token = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop: row.shop, token })
      };
      
    } catch (decryptErr) {
      // ✅ ADD THIS - Log decryption failure
      await errlog({
        shop: row.shop,
        route: '/get-shop-token',
        status: 500,
        message: 'Failed to decrypt shop token',
        detail: decryptErr.message || String(decryptErr),
        request_id,
        code: 'E_DECRYPTION_FAILED',
        client_id
      });
      
      throw decryptErr; // Re-throw to hit outer catch
    }

  } catch (e) {
    // ✅ REPLACE OLD LOGGING - Use new errlog
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}
    
    await errlog({
      shop: body.shop || '',
      route: '/get-shop-token',
      status: 500,
      message: 'Uncaught exception in token decryption',
      detail: e.stack || e.message || String(e),
      request_id,
      code: 'E_EXCEPTION',
      client_id: body.client_id || ''
    }).catch(() => {}); // Fire and forget
    
    return { statusCode: 500, body: "internal error" };
  }
};
