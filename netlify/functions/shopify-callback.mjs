// netlify/functions/shopify-callback.mjs
import crypto from "node:crypto";

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(/; */)
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf("=");
        if (i === -1) return [c, ""];
        const k = c.slice(0, i).trim();
        const v = decodeURIComponent(c.slice(i + 1));
        return [k, v];
      })
  );
}

export const handler = async (event) => {
  const APP_URL = process.env.APP_URL || "https://hooks.seoboss.com";
  const API_KEY =
    process.env.SHOPIFY_API_KEY_PUBLIC || process.env.SHOPIFY_API_KEY || "";
  const SECRET =
    process.env.SHOPIFY_APP_SECRET_PUBLIC ||
    process.env.SHOPIFY_APP_SECRET ||
    "";

  if (!API_KEY || !SECRET) {
    return { statusCode: 500, body: "missing API key/secret" };
  }

  const url = new URL(event.rawUrl);
  const q = Object.fromEntries(url.searchParams.entries());
  const { shop, hmac, code, state, timestamp } = q;

  // Validate shop format
  const shopRe = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
  if (!shopRe.test(shop || "")) {
    return { statusCode: 400, body: "invalid shop" };
  }

  // Verify state (CSRF)
  const cookies = parseCookies(event.headers?.cookie || event.headers?.Cookie || "");
  if (!state || cookies.shopify_oauth_state !== state) {
    return { statusCode: 401, body: "bad state" };
  }

  // Replay guard (10 minutes window)
  const ts = Number(timestamp || 0);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 600) {
    return { statusCode: 401, body: "stale oauth" };
  }

  if (!hmac || !code) {
    return { statusCode: 400, body: "missing params" };
  }

  // Build message for HMAC check (exclude hmac & signature)
  const message = Object.keys(q)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort()
    .map((k) => `${k}=${q[k]}`)
    .join("&");

  const digest = crypto.createHmac("sha256", SECRET).update(message).digest("hex");
  const safe =
    hmac.length === digest.length &&
    crypto.timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(digest, "hex"));
  if (!safe) {
    return { statusCode: 401, body: "invalid hmac" };
  }

  // Exchange code → access token (OFFLINE)
  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: API_KEY, client_secret: SECRET, code }),
  });
  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return { statusCode: 502, body: `token exchange failed: ${err}` };
  }
  const { access_token, scope } = await tokenRes.json();

  // Upsert into your Registry via n8n (non-blocking)
  try {
    await fetch(process.env.N8N_SHOP_UPSERT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || "",
      },
      body: JSON.stringify({
        shop,
        access_token,
        scope,
        installed_at: new Date().toISOString(),
        status: "active",
      }),
    });
  } catch {
    // don't block install on telemetry errors
  }

  // Redirect to your onboarding page and clear state cookie
  return {
    statusCode: 302,
    headers: {
      Location: `https://seoboss.com/pages/connect?shop=${encodeURIComponent(shop)}&installed=1`,
      "Set-Cookie":
        "shopify_oauth_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
    },
    body: "",
  };
};
