import * as jose from 'jose';

const APP_SECRET = process.env.SHOPIFY_APP_SECRET;      // from Partners
const APP_KEY    = process.env.SHOPIFY_API_KEY_PUBLIC;  // from Partners
const secretKey  = new TextEncoder().encode(APP_SECRET);

export async function verifyShopifySessionToken(authHeader) {
  const raw = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!raw) throw Object.assign(new Error('Missing session token'), { status: 401 });

  const { payload } = await jose.jwtVerify(raw, secretKey, {
    algorithms: ['HS256'],
    audience: APP_KEY,
  });

  const now = Math.floor(Date.now()/1000);
  if (payload.nbf && now < payload.nbf) throw Object.assign(new Error('Token not yet valid'), { status: 401 });
  if (payload.exp && now >= payload.exp) throw Object.assign(new Error('Token expired'), { status: 401 });

  const dest = String(payload.dest || '').toLowerCase();
  const shop = dest.replace(/^https?:\/\//,'').replace(/\/+$/,'');
  if (!shop.endsWith('.myshopify.com')) throw Object.assign(new Error('Bad dest'), { status: 401 });

  return { shop, payload };
}
