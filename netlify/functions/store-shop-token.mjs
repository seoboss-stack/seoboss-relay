// netlify/functions/store-shop-token.mjs
import crypto from "node:crypto";
import { logFnError } from "./log.mjs"; // <- logging helper you added

const normShop = (s = "") =>
  String(s).trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/.*/, "")
    .replace(/:\d+$/, "")
    .replace(/\.shopify\.com$/i, ".myshopify.com");

export const handler = async (event) => {
  const request_id = event.headers?.["x-nf-request-id"] || "";
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
      return { statusCode: 500, body: "server not configured: bad N8N_TOKEN_KEY_BASE64" };
    }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return { statusCode: 500, body: "server not configured: missing Supabase env" };
    }

    // AES-256-GCM encrypt token
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const token_b64 = Buffer.concat([enc, tag]).toString("base64");
    const iv_b64 = iv.toString("base64");

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
      // Throw to trigger logging below
      const err = new Error(`db write failed: ${txt}`);
      err.status = rsp.status;
      throw err;
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };

  } catch (e) {
    // Best-effort log; never throw from here
    try {
      await logFnError({
        fn: "store-shop-token",
        shop,
        client_id,
        status: e?.status || 500,
        message: e?.message || String(e),
        request_id,
        stack: e?.stack || null,
      });
    } catch { /* ignore logging failure */ }

    return { statusCode: 500, body: "internal error" };
  }
};
