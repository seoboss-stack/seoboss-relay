// netlify/functions/store-shop-token.mjs
import crypto from "node:crypto";

const normShop = (s="") =>
  String(s).trim().toLowerCase()
    .replace(/^https?:\/\//,'').replace(/[?#].*$/,'')
    .replace(/\/.*/,'').replace(/:\d+$/,'')
    .replace(/\.shopify\.com$/i, '.myshopify.com');

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "POST only" };
  }

  const { shop: rawShop, client_id, token } = JSON.parse(event.body || "{}");
  const shop = normShop(rawShop);
  if (!shop || !token) return { statusCode: 400, body: "missing shop or token" };

  const key = Buffer.from(process.env.N8N_TOKEN_KEY_BASE64 || "", "base64");
  if (key.length !== 32) return { statusCode: 500, body: "bad TOKEN key" };

  // AES-256-GCM
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const token_b64 = Buffer.concat([enc, tag]).toString("base64");
  const iv_b64 = iv.toString("base64");

  // Upsert into Supabase REST
  const url = `${process.env.SUPABASE_URL}/rest/v1/encrypted_shop_tokens`;
  const body = JSON.stringify([{ shop, client_id, token_b64, iv_b64 }]);

  const rsp = await fetch(url, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates"
    },
    body
  });

  if (!rsp.ok) {
    const txt = await rsp.text();
    return { statusCode: 502, body: `db write failed: ${txt}` };
  }
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
