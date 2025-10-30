// netlify/functions/shopify-auth.mjs
import crypto from "node:crypto";
import { hasInstalledShop, normShop } from "./_lib/_install_state.mjs";

export const handler = async (event) => {
  const u = new URL(event.rawUrl);
  const rawShop = (u.searchParams.get("shop") || "").trim();
  const host    = u.searchParams.get("host") || "";   // from embedded Admin

  // Normalize + validate shop
  const shop = normShop(rawShop);
  const shopRe = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
  if (!shopRe.test(shop)) {
    return { statusCode: 400, body: "invalid shop" };
  }

  // ✅ FAST-PATH: already installed? → go straight to your Admin page
  try {
    if (await hasInstalledShop(shop)) {
      const qp = new URLSearchParams({ shop, installed: "1" });
      if (host) qp.set("host", host);
      return {
        statusCode: 302,
        headers: { Location: `https://hooks.seoboss.com/admin/?${qp.toString()}` },
      };
    }
  } catch {
    // ignore and continue with OAuth
  }

  // First-time OAuth
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
    // omit grant_options[]=per-user for OFFLINE tokens
  });

  return {
    statusCode: 302,
    headers: {
      Location: `https://${shop}/admin/oauth/authorize?${params.toString()}`,
      "Set-Cookie": `shopify_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    },
  };
};
