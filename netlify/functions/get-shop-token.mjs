// netlify/functions/get-shop-token.mjs
import crypto from "node:crypto";
import { logFnError } from "./log.mjs";

const normShop = (s = "") =>
  String(s).trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/.*/, "")
    .replace(/:\d+$/, "")
    .replace(/\.shopify\.com$/i, ".myshopify.com");

export const handler = async (event) => {
  const request_id = event.headers?.["x-nf-request-id"] || "";
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
    if (!url || !key || !keyB64) return { statusCode: 500, body: "missing env" };

    const filter = client_id
      ? `client_id=eq.${encodeURIComponent(client_id)}`
      : `shop=eq.${encodeURIComponent(shop)}`;

    // fetch encrypted row
    const rsp = await fetch(
      `${url}/rest/v1/encrypted_shop_tokens?select=shop,token_b64,iv_b64&${filter}&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!rsp.ok) return { statusCode: rsp.status, body: await rsp.text() };
    const [row] = await rsp.json();
    if (!row) return { statusCode: 404, body: "not found" };

    // decrypt AES-256-GCM (ciphertext|tag)
    const k = Buffer.from(keyB64, "base64");
    if (k.length !== 32) return { statusCode: 500, body: "bad key length" };

    const iv  = Buffer.from(row.iv_b64, "base64");
    const raw = Buffer.from(row.token_b64, "base64");
    if (raw.length < 17) return { statusCode: 500, body: "ciphertext too short" };

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
  } catch (e) {
    try {
      await logFnError({
        fn: "get-shop-token",
        status: 500,
        message: e?.message || String(e),
        request_id
      });
    } catch {}
    return { statusCode: 500, body: "internal error" };
  }
};
