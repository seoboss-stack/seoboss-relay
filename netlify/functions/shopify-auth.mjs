// auth.mjs (suggested)
import crypto from "node:crypto";

export const handler = async (event) => {
  const u = new URL(event.rawUrl);
  const shop = u.searchParams.get("shop");
  if (!shop) return { statusCode: 400, body: "missing shop" };

  const APP_URL = process.env.APP_URL || "https://hooks.seoboss.com";
  const API_KEY = process.env.SHOPIFY_API_KEY_PUBLIC || process.env.SHOPIFY_API_KEY;

  const params = new URLSearchParams({
    client_id: API_KEY,
    redirect_uri: `${APP_URL}/.netlify/functions/shopify-callback`,
    state: crypto.randomUUID(),
  });

  return {
    statusCode: 302,
    headers: { Location: `https://${shop}/admin/oauth/authorize?${params}` },
  };
};
