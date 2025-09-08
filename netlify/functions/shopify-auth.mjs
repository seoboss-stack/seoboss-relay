import crypto from "node:crypto";

export const handler = async (event) => {
  const u = new URL(event.rawUrl);
  const shop = u.searchParams.get("shop");
  if (!shop) return { statusCode: 400, body: "missing shop" };

  const APP_URL  = process.env.APP_URL || "https://hooks.seoboss.com";
  const API_KEY  = process.env.SHOPIFY_API_KEY_PUBLIC || process.env.SHOPIFY_API_KEY;

  // Minimal scopes to create blog posts. Add more later (e.g., write_files).
  const scopes = ["read_content","write_content"].join(",");

  const params = new URLSearchParams({
    client_id: API_KEY,
    scope: scopes,
    redirect_uri: `${APP_URL}/.netlify/functions/shopify-callback`,
    state: crypto.randomUUID(),               // TODO: persist & verify if you want CSRF hardening
    // optional: "grant_options[]": "per-user" // for online tokens (omit for offline)
  });

  return {
    statusCode: 302,
    headers: { Location: `https://${shop}/admin/oauth/authorize?${params}` },
  };
};
