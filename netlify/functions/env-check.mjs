export const handler = async () => ({
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    has_SHOPIFY_API_KEY: !!process.env.SHOPIFY_API_KEY,
    has_SHOPIFY_API_SECRET: !!process.env.SHOPIFY_API_SECRET,
  }),
});
