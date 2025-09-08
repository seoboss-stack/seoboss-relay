// netlify/functions/uninstalled.mjs
import crypto from "node:crypto";

function verifyWebhook(raw, hmac, secret) {
  const digest = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac || "", "base64"));
}

export const handler = async (event) => {
  const SECRET = process.env.SHOPIFY_APP_SECRET_PUBLIC || process.env.SHOPIFY_APP_SECRET;
  const topic  = event.headers["x-shopify-topic"];
  const shop   = event.headers["x-shopify-shop-domain"];
  const hmac   = event.headers["x-shopify-hmac-sha256"];

  if (!verifyWebhook(event.body || "", hmac, SECRET)) {
    return { statusCode: 401, body: "bad hmac" };
  }

  // Tell n8n to deactivate & wipe the token
  try {
    await fetch(process.env.N8N_SHOP_DEACTIVATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || ""
      },
      body: JSON.stringify({ shop, topic })
    });
  } catch {}

  return { statusCode: 200, body: "ok" };
};
