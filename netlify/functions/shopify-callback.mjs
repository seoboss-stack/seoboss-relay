// netlify/functions/shopify-callback.mjs
import crypto from "node:crypto";

export const handler = async (event) => {
  const APP_URL = process.env.APP_URL || "https://hooks.seoboss.com";
  const API_KEY = process.env.SHOPIFY_API_KEY_PUBLIC || process.env.SHOPIFY_API_KEY;
  const SECRET  = process.env.SHOPIFY_APP_SECRET_PUBLIC || process.env.SHOPIFY_APP_SECRET;

  const url = new URL(event.rawUrl);
  const params = Object.fromEntries(url.searchParams.entries());
  const { shop, hmac, code } = params;
  if (!shop || !hmac || !code) return { statusCode: 400, body: "missing params" };

  // Verify HMAC (exclude hmac & signature)
  const msg = Object.keys(params)
    .filter(k => k !== "hmac" && k !== "signature")
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join("&");

  const digest = crypto.createHmac("sha256", SECRET).update(msg).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(digest, "hex"))) {
    return { statusCode: 401, body: "invalid hmac" };
  }

  // Exchange code → token
  const resp = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: API_KEY, client_secret: SECRET, code }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    return { statusCode: 502, body: `token exchange failed: ${err}` };
  }

  // TODO: save {shop, access_token, scope} if/when needed

  return { statusCode: 302, headers: { Location: `${APP_URL}/installed` } };
};
