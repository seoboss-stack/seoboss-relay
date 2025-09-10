// netlify/functions/shopify-callback.mjs
import crypto from "node:crypto";

function parseCookies(header = "") {
  return Object.fromEntries(
    (header || "").split(/; */).filter(Boolean).map((c) => {
      const i = c.indexOf("="); if (i === -1) return [c, ""];
      return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
    })
  );
}

export const handler = async (event) => {
  const API_KEY = process.env.SHOPIFY_API_KEY_PUBLIC || process.env.SHOPIFY_API_KEY || "";
  const SECRET  = process.env.SHOPIFY_APP_SECRET_PUBLIC || process.env.SHOPIFY_APP_SECRET || "";
  const ONBOARD_URL = process.env.N8N_ONBOARD_SUBMIT_URL; 

  if (!API_KEY || !SECRET)  return { statusCode: 500, body: "missing API key/secret" };
  if (!ONBOARD_URL)         return { statusCode: 500, body: "missing N8N_ONBOARD_SUBMIT_URL" };

  const url = new URL(event.rawUrl);
  const q = Object.fromEntries(url.searchParams.entries());
  const { shop, hmac, code, state, timestamp } = q;

  // Validate shop + state
  const shopRe = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
  if (!shopRe.test(shop || "")) return { statusCode: 400, body: "invalid shop" };
  const cookies = parseCookies(event.headers?.cookie || event.headers?.Cookie || "");
  if (!state || cookies.shopify_oauth_state !== state) return { statusCode: 401, body: "bad state" };

  // Replay + HMAC
  const ts = Number(timestamp || 0);
  if (!ts || Math.abs(Date.now()/1000 - ts) > 600) return { statusCode: 401, body: "stale oauth" };
  if (!hmac || !code) return { statusCode: 400, body: "missing params" };

  const message = Object.keys(q)
    .filter(k => k !== "hmac" && k !== "signature")
    .sort().map(k => `${k}=${q[k]}`).join("&");
  const digest = crypto.createHmac("sha256", SECRET).update(message).digest("hex");
  const safe = hmac.length === digest.length &&
    crypto.timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(digest, "hex"));
  if (!safe) return { statusCode: 401, body: "invalid hmac" };

  // OAuth code -> offline access token
  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: API_KEY, client_secret: SECRET, code }),
  });
  if (!tokenRes.ok) return { statusCode: 502, body: `token exchange failed: ${await tokenRes.text()}` };
  const { access_token, scope } = await tokenRes.json();

  // Send to YOUR onboarding flow (NOT upsert)
  try {
    await fetch(ONBOARD_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || "",
        "X-Seoboss-Ts": String(Math.floor(Date.now()/1000)),
        "X-Debug-From": "shopify-callback"
      },
      body: new URLSearchParams({
        client_name: "",
        contact_email: "",
        default_language: "en",
        shop_input: shop,           
        admin_token: access_token,  // ...and this
        tone: "",
        niche: "",
        seed_keywords: "",
        target_audience: ""
      }).toString(),
    });
  } catch (e) {
    console.error("onboarding submit failed", e);
    // don't block install
  }

  // Redirect to connect page
  return {
    statusCode: 302,
    headers: {
      Location: `https://seoboss.com/pages/connect?shop=${encodeURIComponent(shop)}&installed=1`,
      "Set-Cookie": "shopify_oauth_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
    },
    body: "",
  };
};
