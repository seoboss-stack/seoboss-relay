import crypto from "node:crypto";

function verifyWebhook(reqBody, hmacHeader, secret) {
  const digest = crypto.createHmac("sha256", secret).update(reqBody, "utf8").digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader || "", "base64"));
}

export const handler = async (event) => {
  const SECRET = process.env.SHOPIFY_APP_SECRET_PUBLIC || process.env.SHOPIFY_APP_SECRET;
  const topic = event.headers["x-shopify-topic"];
  const hmac  = event.headers["x-shopify-hmac-sha256"];
  const ok = verifyWebhook(event.body || "", hmac, SECRET);
  if (!ok) return { statusCode: 401, body: "bad hmac" };

  // You can log or perform deletions here as required by topic:
  // customers/data_request, customers/redact, shop/redact
  return { statusCode: 200, body: "ok" };
};
