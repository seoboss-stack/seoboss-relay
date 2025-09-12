// netlify/functions/uninstalled.mjs
import crypto from "node:crypto";

function toLowerHeaders(h = {}) {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

function verifyWebhookHmac(rawBuf, secret, sentB64) {
  if (!secret || !sentB64) return false;
  const digestB64 = crypto.createHmac("sha256", secret).update(rawBuf).digest("base64");
  // Decode BOTH to raw bytes, then timing-safe compare
  const a = Buffer.from(digestB64, "base64");
  const b = Buffer.from(String(sentB64), "base64");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST only" };

  const SECRET =
    process.env.SHOPIFY_APP_SECRET_PUBLIC ||
    process.env.SHOPIFY_APP_SECRET || "";
  const DEACTIVATE = process.env.N8N_SHOP_DEACTIVATE_URL || "";
  const FWD = process.env.FORWARD_SECRET || "";

  if (!SECRET || !DEACTIVATE) return { statusCode: 500, body: "missing env" };

  const headers = toLowerHeaders(event.headers);
  const topic = (headers["x-shopify-topic"] || "").toLowerCase();
  const shop = headers["x-shopify-shop-domain"] || "";
  const sentHmac = headers["x-shopify-hmac-sha256"] || "";

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64")
    : Buffer.from(event.body || "", "utf8");

  if (!verifyWebhookHmac(raw, SECRET, sentHmac)) {
    return { statusCode: 401, body: "bad hmac" };
  }

  if (topic !== "app/uninstalled") {
    return { statusCode: 200, body: "ok (ignored topic)" };
  }

  try {
    await fetch(DEACTIVATE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SEOBOSS-FORWARD-SECRET": FWD,
      },
      body: JSON.stringify({
        shop_url: shop,
        topic,
        uninstalled_at: new Date().toISOString(),
      }),
    });
  } catch { /* already ACKed */ }

  return { statusCode: 200, body: "ok" };
};
