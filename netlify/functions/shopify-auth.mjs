import crypto from "node:crypto";

export const handler = async (event) => {
  const shop = new URL(event.rawUrl).searchParams.get("shop");
  if (!shop) return { statusCode: 400, body: "missing shop" };

  const params = new URLSearchParams({
    client_id: process.env.SHOPIFY_API_KEY,
    scope: "read_content", // <-- add this
    redirect_uri: `${process.env.APP_URL}/.netlify/functions/shopify-callback`,
    state: crypto.randomUUID(),
  });

  return {
    statusCode: 302,
    headers: { Location: `https://${shop}/admin/oauth/authorize?${params}` },
  };
};
