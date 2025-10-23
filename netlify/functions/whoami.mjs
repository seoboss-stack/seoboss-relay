import { verifyShopifySessionToken } from './_auth.mjs';

export default async (req) => {
  try {
    const { shop } = await verifyShopifySessionToken(req.headers.get('authorization'));
    return new Response(JSON.stringify({ ok:true, connected:true, shop }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok:false, connected:false, error: err.message }), {
      status: err.status || 401, headers: { 'Content-Type': 'application/json' }
    });
  }
};
