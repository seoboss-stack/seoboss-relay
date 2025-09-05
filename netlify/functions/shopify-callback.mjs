import crypto from "node:crypto";
export const handler = async (event) => {
  const u = new URL(event.rawUrl);
  const shop = u.searchParams.get("shop");
  const hmac = u.searchParams.get("hmac");
  const code = u.searchParams.get("code");
  const msg = [...u.searchParams].filter(([k]) => k!=="hmac").sort()
    .map(([k,v])=>`${k}=${v}`).join("&");
  const digest = crypto.createHmac("sha256", process.env.SHOPIFY_APP_SECRET).update(msg).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(hmac,"hex"), Buffer.from(digest,"hex")))
    return { statusCode: 401, body: "bad hmac" };

  // Exchange for token (we don't need to store it yet)
  await fetch(`https://${shop}/admin/oauth/access_token`, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ client_id: process.env.SHOPIFY_API_KEY, client_secret: process.env.SHOPIFY_APP_SECRET, code })
  });

  return { statusCode: 302, headers: { Location: `${process.env.APP_URL}/installed` } };
};
