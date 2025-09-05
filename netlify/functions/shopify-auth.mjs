export const handler = async (event) => {
  const shop = new URL(event.rawUrl).searchParams.get("shop");
  const params = new URLSearchParams({
    client_id: process.env.SHOPIFY_API_KEY,
    scope: "",
    redirect_uri: `${process.env.APP_URL}/.netlify/functions/shopify-callback`,
    state: crypto.randomUUID()
  });
  return {
    statusCode: 302,
    headers: { Location: `https://${shop}/admin/oauth/authorize?${params}` }
  };
};
