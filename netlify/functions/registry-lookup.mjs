// netlify/functions/registry-lookup.mjs (or whatever the filename is)
import { errlog } from './_lib/_errlog.mjs';  // ✅ ADD THIS

// POST or GET ?shop=xxx.myshopify.com  →  { client_id: "cli_..." }
export const handler = async (event) => {
  // ✅ ADD THIS - Extract request_id
  const request_id = event.headers?.["x-request-id"] || event.headers?.["X-Request-Id"] || '';
  
  try {
    const FWD = process.env.FORWARD_SECRET || "";
    const got = event.headers["x-seoboss-forward-secret"] || event.headers["X-Seoboss-Forward-Secret"] || "";
    
    if (!FWD || got !== FWD) return { statusCode: 401, body: "forbidden" };
    
    const url = new URL(event.rawUrl);
    const shop = (url.searchParams.get("shop") || "").toLowerCase().trim();
    
    if (!shop) return { statusCode: 400, body: "missing shop" };
    
    const sbUrl = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
    
    const r = await fetch(`${sbUrl}/rest/v1/registry?select=client_id,shop_url&shop_url=eq.${encodeURIComponent(shop)}&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    
    // ✅ ADD THIS - Log registry lookup failures
    if (!r.ok) {
      const errorText = await r.text();
      await errlog({
        shop,
        route: '/registry-lookup',
        status: r.status,
        message: 'Failed to query registry table',
        detail: errorText,
        request_id,
        code: 'E_DB_READ'
      });
      return { statusCode: r.status, body: errorText };
    }
    
    const [row] = await r.json();
    
    if (!row) {
      // Not logging 404s - it's expected when shop isn't registered yet
      return { statusCode: 404, body: "not found" };
    }
    
    return { 
      statusCode: 200, 
      headers: { "Content-Type": "application/json" }, 
      body: JSON.stringify({ client_id: row.client_id }) 
    };
    
  } catch (e) {
    // ✅ ADD THIS - Log uncaught exceptions
    const url = new URL(event.rawUrl);
    const shop = url.searchParams.get("shop") || '';
    
    await errlog({
      shop,
      route: '/registry-lookup',
      status: 500,
      message: 'Uncaught exception in registry lookup',
      detail: e.stack || e.message || String(e),
      request_id,
      code: 'E_EXCEPTION'
    });
    
    return { statusCode: 500, body: "error" };
  }
};
