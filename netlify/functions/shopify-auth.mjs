// netlify/functions/shopify-auth.mjs
import crypto from "node:crypto";

export const handler = async (event) => {
  const u = new URL(event.rawUrl);
  const shop = (u.searchParams.get("shop") || "").trim();

  // Basic shop validation
  const shopRe = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
  if (!shopRe.test(shop)) {
    return { statusCode: 400, body: "invalid shop" };
  }

  const APP_URL = process.env.APP_URL || "https://hooks.seoboss.com";
  const API_KEY =
    process.env.SHOPIFY_API_KEY_PUBLIC || process.env.SHOPIFY_API_KEY || "";
  const SCOPES =
    process.env.SHOPIFY_SCOPES ||
    "read_content,write_content,read_files,write_files";

  if (!API_KEY) {
    return { statusCode: 500, body: "missing SHOPIFY_API_KEY_PUBLIC" };
  }

  // Anti-CSRF state
  const state = crypto.randomUUID();

  const params = new URLSearchParams({
    client_id: API_KEY,
    scope: SCOPES,
    redirect_uri: `${APP_URL}/.netlify/functions/shopify-callback`,
    state,
    // NOTE: omit grant_options[]=per-user for OFFLINE tokens (best for server-to-server)
  });

  return {
    statusCode: 302,
    headers: {
      Location: `https://${shop}/admin/oauth/authorize?${params.toString()}`,
      // Lax is fine because we initiate on your site → Shopify → back to you
      "Set-Cookie": `shopify_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    },
  };
};
