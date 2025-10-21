// GET /.netlify/functions/list-blogs?shop=<store>.myshopify.com
import { errlog } from './_lib/_errlog.mjs';  // ✅ ADD THIS

const ALLOW_ORIGIN = "https://seoboss.com"; // your connect page origin

const cors = () => ({
  "Access-Control-Allow-Origin": ALLOW_ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

const normShop = s => String(s||"").trim().toLowerCase()
  .replace(/^https?:\/\//,"").replace(/[?#].*$/,"").replace(/\/.*/,"")
  .replace(/:\d+$/,"").replace(/\.shopify\.com$/i,".myshopify.com");

async function getVaultToken(shop){
  const base=(process.env.PUBLIC_BASE_URL||process.env.APP_URL||"").replace(/\/$/,"");
  const res=await fetch(`${base}/.netlify/functions/get-shop-token`,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || ""
    },
    body: JSON.stringify({ shop })
  });
  if(!res.ok) throw new Error(`vault ${res.status}: ${await res.text()}`);
  const { token } = await res.json();
  if(!String(token).startsWith("shpat_")) throw new Error("no token");
  return token;
}

export const handler = async (event) => {
  // ✅ ADD THIS - Extract request_id
  const request_id = event.headers?.["x-request-id"] || event.headers?.["X-Request-Id"] || '';
  
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }
  
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: cors(), body: "GET only" };
  }

  try {
    const shop = normShop(new URL(event.rawUrl).searchParams.get("shop"));
    
    if (!shop) return { statusCode: 400, headers: cors(), body: "missing shop" };

    let token;
    try {
      token = await getVaultToken(shop);
    } catch (e) {
      // ✅ ADD THIS - Log token retrieval failure
      await errlog({
        shop,
        route: '/list-blogs',
        status: 500,
        message: 'Failed to retrieve shop token for blog listing',
        detail: e.message || String(e),
        request_id,
        code: 'E_TOKEN_RETRIEVAL'
      }).catch(() => {});
      
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok:false, error: "token_not_found" }) };
    }

    const resp = await fetch(`https://${shop}/admin/api/2024-10/blogs.json`, {
      headers: { "X-Shopify-Access-Token": token }
    });
    
    const body = await resp.json();
    
    if (!resp.ok) {
      // ✅ ADD THIS - Log Shopify API failure
      await errlog({
        shop,
        route: '/list-blogs',
        status: resp.status,
        message: 'Shopify blogs list API failed',
        detail: JSON.stringify(body),
        request_id,
        code: 'E_SHOPIFY_API'
      }).catch(() => {});
      
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok:false, error: body }) };
    }

    const blogs = (body.blogs || []).map(b => ({ id: String(b.id), title: b.title }));
    
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok:true, shop, blogs }) };
    
  } catch (e) {
    // ✅ ADD THIS - Log uncaught exceptions
    const shop = normShop(new URL(event.rawUrl).searchParams.get("shop") || '');
    
    await errlog({
      shop,
      route: '/list-blogs',
      status: 500,
      message: 'Uncaught exception in list-blogs',
      detail: e.stack || e.message || String(e),
      request_id,
      code: 'E_EXCEPTION'
    }).catch(() => {});
    
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok:false, error: String(e.message||e) }) };
  }
};
