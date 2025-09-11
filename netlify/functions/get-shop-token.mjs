// Decrypt + return { shop, token } for a given client_id or shop
import crypto from "node:crypto";
import fetch from "node-fetch";

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST only" };

  const FWD = process.env.FORWARD_SECRET || "";
  if (!FWD || event.headers["x-seoboss-forward-secret"] !== FWD) {
    return { statusCode: 401, body: "forbidden" };
  }

  const { client_id = "", shop = "" } = JSON.parse(event.body || "{}");
  if (!client_id && !shop) return { statusCode: 400, body: "client_id or shop required" };

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const keyB64 = process.env.N8N_TOKEN_KEY_BASE64;
  if (!url || !key || !keyB64) return { statusCode: 500, body: "missing env" };

  // 1) find row
  const filter = client_id
    ? `client_id=eq.${encodeURIComponent(client_id)}`
    : `shop=eq.${encodeURIComponent(shop)}`;

  const rsp = await fetch(`${url}/rest/v1/encrypted_shop_tokens?select=shop,token_b64,iv_b64&${filter}&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (!rsp.ok) return { statusCode: rsp.status, body: await rsp.text() };
  const [row] = await rsp.json();
  if (!row) return { statusCode: 404, body: "not found" };

  // 2) decrypt AES-256-GCM
  const keyBuf = Buffer.from(keyB64, "base64");
  const iv = Buffer.from(row.iv_b64, "base64");
  const raw = Buffer.from(row.token_b64, "base64"); // ciphertext|tag
  const tag = raw.subarray(raw.length - 16);
  const ct  = raw.subarray(0, raw.length - 16);

  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBuf, iv);
  decipher.setAuthTag(tag);
  const token = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shop: row.shop, token })
  };
};
