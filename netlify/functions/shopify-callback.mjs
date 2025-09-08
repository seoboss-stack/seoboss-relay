// netlify/functions/shopify-callback.mjs
import crypto from "node:crypto";

export const handler = async (event) => {
  const APP_URL = process.env.APP_URL || "https://hooks.seoboss.com";
  const API_KEY = process.env.SHOPIFY_API_KEY_PUBLIC || process.env.SHOPIFY_API_KEY;
  const SECRET  = process.env.SHOPIFY_APP_SECRET_PUBLIC || process.env.SHOPIFY_APP_SECRET;

  const url = new URL(event.rawUrl);
  const params = Object.fromEntries(url.searchParams.entries());
  const { shop, hmac, code, state } = params;
  if (!shop || !hmac || !code) return { statusCode: 400, body: "missing params" };

  // (optional) light sanity check
  if (!/\.myshopify\.com$/i.test(shop)) {
    return { statusCode: 400, body: "invalid shop" };
  }

  // Build message (exclude hmac & signature)
  const msg = Object.keys(params)
    .filter(k => k !== "hmac" && k !== "signature")
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join("&");

  const digest = crypto.createHmac("sha256", SECRET).update(msg).digest("hex");

  // 👉 timingSafeEqual throws if lengths differ—guard first
  const bufA = Buffer.from(hmac, "hex");
  const bufB = Buffer.from(digest, "hex");
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
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
  const { access_token, scope } = await resp.json();

  // TODO: persist {shop, access_token, scope} if/when needed
  // TODO (public apps): register privacy webhooks + app/uninstalled

  return { statusCode: 302, headers: { Location: `${APP_URL}/installed` } };
};
