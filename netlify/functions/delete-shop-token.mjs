// netlify/functions/delete-shop-token.mjs
import { errlog } from './_lib/_errlog.mjs';  // ✅ REPLACE OLD IMPORT

const normShop = (s="") => String(s).trim().toLowerCase()
  .replace(/^https?:\/\//,"").replace(/[?#].*$/,"").replace(/\/.*/,"")
  .replace(/:\d+$/,"").replace(/\.shopify\.com$/i,".myshopify.com");

export const handler = async (event) => {
  // ✅ ADD THIS - Extract request_id
  const request_id = event.headers?.["x-request-id"] || event.headers?.["X-Request-Id"] || '';
  
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST only" };
    
    const FWD = process.env.FORWARD_SECRET || "";
    if (!FWD || (event.headers["x-seoboss-forward-secret"] !== FWD)) {
      return { statusCode: 401, body: "forbidden" };
    }
    
    const { client_id = "", shop: rawShop = "" } = JSON.parse(event.body || "{}");
    if (!client_id && !rawShop) return { statusCode: 400, body: "client_id or shop required" };
    
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) return { statusCode: 500, body: "missing env" };
    
    const shop = normShop(rawShop);
    const filter = client_id
      ? `client_id=eq.${encodeURIComponent(client_id)}`
      : `shop=eq.${encodeURIComponent(shop)}`;
    
    const rsp = await fetch(`${url}/rest/v1/encrypted_shop_tokens?${filter}`, {
      method: "DELETE",
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    
    // ✅ ADD THIS - Log Supabase DELETE failure
    if (!rsp.ok) {
      const errorText = await rsp.text();
      await errlog({
        shop,
        route: '/delete-shop-token',
        status: rsp.status,
        message: 'Failed to delete shop token from Supabase',
        detail: errorText,
        request_id,
        code: 'E_DB_DELETE',
        client_id
      });
      return { statusCode: rsp.status, body: errorText };
    }
    
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    
  } catch (e) {
    // ✅ REPLACE OLD LOGGING - Use new errlog
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}
    
    await errlog({
      shop: normShop(body.shop || ''),
      route: '/delete-shop-token',
      status: 500,
      message: 'Uncaught exception in delete-shop-token',
      detail: e.stack || String(e),
      request_id,
      code: 'E_EXCEPTION',
      client_id: body.client_id || ''
    });
    
    return { statusCode: 500, body: "internal error" };
  }
};
