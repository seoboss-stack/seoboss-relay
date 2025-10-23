// netlify/functions/_auth.mjs
import { jwtVerify } from "jose";

const enc = (s) => new TextEncoder().encode(s);

/**
 * Verifies the Shopify Admin session token coming from App Bridge:
 * - HS256 signed with your APP SECRET
 * - audience must equal your PUBLIC API KEY
 * Returns { shop, payload }
 */
export async function verifyShopifySessionToken(authHeader = "") {
  if (!authHeader?.startsWith("Bearer ")) throw new Error("missing bearer");
  const token = authHeader.slice(7).trim();

  const apiKey    = process.env.SHOPIFY_API_KEY       || process.env.PUBLIC_API_KEY;
  const apiSecret = process.env.SHOPIFY_APP_SECRET    || process.env.SHOPIFY_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error("missing app credentials");

  const { payload } = await jwtVerify(token, enc(apiSecret), {
    audience: apiKey, // must match your app’s public API key
  });

  // payload.dest looks like "https://yourshop.myshopify.com/admin"
  const dest = String(payload.dest || "");
  const host = new URL(dest).host.toLowerCase(); // yourshop.myshopify.com
  const shop = host.replace(/\.shopify\.com$/i, ".myshopify.com");

  return { shop, payload };
}
