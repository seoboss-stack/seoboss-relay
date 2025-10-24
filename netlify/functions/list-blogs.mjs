// GET /.netlify/functions/list-blogs[?shop=<store>.myshopify.com]
// Works for BOTH: legacy (?shop=) and embedded (Authorization: Bearer <Shopify JWT>)
import { errlog } from './_lib/_errlog.mjs';

const STATIC_ALLOW = new Set([
  'https://seoboss.com',
  'https://hooks.seoboss.com',
  'https://admin.shopify.com',
]);

function isAllowedOrigin(origin='') {
  try {
    if (!origin) return false;
    if (STATIC_ALLOW.has(origin)) return true;
    const u = new URL(origin);
    return u.hostname.endsWith('.myshopify.com'); // storefronts/theme editor etc.
  } catch { return false; }
}

function cors(origin){
  const allow = isAllowedOrigin(origin) ? origin : 'https://seoboss.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  };
}

const normShop = s => String(s||'').trim().toLowerCase()
  .replace(/^https?:\/\//,'').replace(/[?#].*$/,'').replace(/\/.*/,'')
  .replace(/:\d+$/,'').replace(/\.shopify\.com$/i,'.myshopify.com');

function readBearer(event){
  const h = event.headers || {};
  const v = h.authorization || h.Authorization || '';
  const m = /^Bearer\s+(.+)$/.exec(v);
  return m ? m[1] : '';
}
function b64url(s=''){ return Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8'); }
function decodeShopifyJWT(jwt){
  const parts = String(jwt||'').split('.');
  if (parts.length < 2) throw new Error('bad_session_token');
  const payload = JSON.parse(b64url(parts[1]));
  const dest = String(payload.dest || '').replace(/^https?:\/\//,'').toLowerCase();
  if (!dest || !/\.myshopify\.com$/i.test(dest)) throw new Error('bad_dest');
  return { shop: dest, payload };
}

async function getVaultToken(shop){
  const base=(process.env.PUBLIC_BASE_URL||process.env.APP_URL||'').replace(/\/$/,'');
  const res=await fetch(`${base}/.netlify/functions/get-shop-token`,{
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'X-SEOBOSS-FORWARD-SECRET': process.env.FORWARD_SECRET || ''
    },
    body: JSON.stringify({ shop })
  });
  if(!res.ok) throw new Error(`vault ${res.status}: ${await res.text()}`);
  const { token } = await res.json();
  if (!token) throw new Error('no token');
  return String(token);
}

export const handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const request_id = event.headers?.['x-request-id'] || event.headers?.['X-Request-Id'] || '';

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(origin), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: cors(origin), body: 'GET only' };
  }

  try {
    // Prefer ?shop= for legacy, else derive from Shopify session token
    const shopQs = normShop(new URL(event.rawUrl).searchParams.get('shop'));
    let shop = shopQs;
    if (!shop) {
      const jwt = readBearer(event);
      const d = decodeShopifyJWT(jwt); // throws if invalid
      shop = d.shop;
    }
    if (!shop) return { statusCode: 400, headers: cors(origin), body: 'missing shop' };

    let token;
    try {
      token = await getVaultToken(shop);
    } catch (e) {
      await errlog({
        shop, route: '/list-blogs', status: 500,
        message: 'Failed to retrieve shop token for blog listing',
        detail: e.message || String(e), request_id, code: 'E_TOKEN_RETRIEVAL'
      }).catch(()=>{});
      // keep response shape consistent with old handler
      return { statusCode: 200, headers: cors(origin), body: JSON.stringify({ ok:false, error:'token_not_found' }) };
    }

    const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-10';
    const resp = await fetch(`https://${shop}/admin/api/${apiVersion}/blogs.json`, {
      headers: { 'X-Shopify-Access-Token': token, 'Accept':'application/json' }
    });
    const body = await resp.json().catch(()=> ({}));

    if (!resp.ok) {
      await errlog({
        shop, route: '/list-blogs', status: resp.status,
        message: 'Shopify blogs list API failed',
        detail: JSON.stringify(body).slice(0, 1000), request_id, code: 'E_SHOPIFY_API'
      }).catch(()=>{});
      return { statusCode: 200, headers: cors(origin), body: JSON.stringify({ ok:false, error: body }) };
    }

    const blogs = Array.isArray(body.blogs) ? body.blogs.map(b => ({ id:String(b.id), title:b.title })) : [];
    const default_blog_id = blogs[0]?.id || null;

    return {
      statusCode: 200,
      headers: { ...cors(origin), 'Content-Type':'application/json' },
      body: JSON.stringify({ ok:true, shop, blogs, default_blog_id })
    };

  } catch (e) {
    const shop = (()=>{ try { return normShop(new URL(event.rawUrl).searchParams.get('shop')); } catch { return ''; }})();
    await errlog({
      shop, route: '/list-blogs', status: 500,
      message: 'Uncaught exception in list-blogs',
      detail: e.stack || e.message || String(e), request_id, code: 'E_EXCEPTION'
    }).catch(()=>{});
    return {
      statusCode: 200,
      headers: { ...cors(origin), 'Content-Type':'application/json' },
      body: JSON.stringify({ ok:false, error: String(e.message||e) })
    };
  }
};
