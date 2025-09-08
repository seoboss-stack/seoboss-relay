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

  // 1) Exchange code → access token
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

  // 2) SAVE to your Registry (n8n) — NEW
  try {
    await fetch(process.env.N8N_SHOP_UPSERT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || ""
      },
      body: JSON.stringify({
        shop,
        access_token,
        scope,
        installed_at: new Date().toISOString(),
        status: "active"
      })
    });
  } catch (e) {
    // don’t block install if telemetry save fails
    console.error("registry upsert failed:", e?.message);
  }

  // 3) Redirect to your post-install page
  return { statusCode: 302, headers: { Location: `${APP_URL}/installed` } };
};
