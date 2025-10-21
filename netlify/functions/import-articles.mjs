// netlify/functions/import-articles.mjs
import crypto from "node:crypto";
import { errlog } from './_lib/_errlog.mjs';  // ✅ ADD THIS

function canonicalForm(obj){
  return Object.entries(obj||{})
    .filter(([,v]) => v !== undefined && v !== null && String(v).trim() !== "")
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v))).join("&");
}

export const handler = async (event) => {
  // ✅ ADD THIS - Extract request_id
  const request_id = event.headers?.["x-request-id"] || event.headers?.["X-Request-Id"] || '';
  
  try{
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST only" };
    
    const FWD_SECRET = process.env.FORWARD_SECRET || "";
    const PUBLIC_HMAC_KEY = process.env.PUBLIC_HMAC_KEY || "";
    const N8N_IMPORT_URL = process.env.N8N_IMPORT_ARTICLES_URL; // e.g. https://.../webhook/seoboss/api/shop/import-articles
    
    if (!FWD_SECRET || !PUBLIC_HMAC_KEY || !N8N_IMPORT_URL) {
      // ✅ ADD THIS - Log missing configuration
      await errlog({
        shop: '',
        route: '/import-articles',
        status: 500,
        message: 'Import articles configuration missing',
        detail: `FWD_SECRET: ${!!FWD_SECRET}, HMAC_KEY: ${!!PUBLIC_HMAC_KEY}, N8N_URL: ${!!N8N_IMPORT_URL}`,
        request_id,
        code: 'E_CONFIG'
      }).catch(() => {});
      
      return { statusCode: 500, body: "missing env FORWARD_SECRET/PUBLIC_HMAC_KEY/N8N_IMPORT_ARTICLES_URL" };
    }
    
    const params = new URLSearchParams(event.body || "");
    const client_id = (params.get("client_id") || "").trim();
    const shop = (params.get("shop") || "").trim().toLowerCase();
    
    const body = canonicalForm({ client_id, shop });
    const ts = Math.floor(Date.now()/1000).toString();
    const sig = crypto.createHmac("sha256", PUBLIC_HMAC_KEY).update(body + "\n" + ts).digest("hex");
    
    let rsp;
    try {
      rsp = await fetch(N8N_IMPORT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Seoboss-Ts": ts,
          "X-Seoboss-Hmac": sig,
          "X-Seoboss-Key-Id": "global",
          "X-SEOBOSS-FORWARD-SECRET": FWD_SECRET,
          "X-Request-Id": request_id  // ✅ ADD THIS - Forward correlation ID
        },
        body
      });
    } catch (err) {
      // ✅ ADD THIS - Log n8n fetch failure
      await errlog({
        shop,
        route: '/import-articles',
        status: 500,
        message: 'Failed to reach n8n import endpoint',
        detail: `client_id: ${client_id}, shop: ${shop}, error: ${err.message}`,
        request_id,
        code: 'E_N8N_UNREACHABLE',
        client_id
      }).catch(() => {});
      
      throw err;
    }
    
    // ✅ ADD THIS - Log if n8n returns error
    if (!rsp.ok) {
      const errorText = await rsp.clone().text();
      await errlog({
        shop,
        route: '/import-articles',
        status: rsp.status,
        message: 'n8n import endpoint returned error',
        detail: errorText.slice(0, 500),
        request_id,
        code: 'E_N8N_FAILED',
        client_id
      }).catch(() => {});
    }
    
    const text = await rsp.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw:text }; }
    
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: rsp.ok, stats: data?.stats || null })
    };
    
  }catch(e){
    // ✅ ADD THIS - Log uncaught exceptions
    const params = new URLSearchParams(event.body || "");
    const shop = (params.get("shop") || "").trim().toLowerCase();
    const client_id = (params.get("client_id") || "").trim();
    
    await errlog({
      shop,
      route: '/import-articles',
      status: 500,
      message: 'Uncaught exception in import-articles',
      detail: e.stack || e.message || String(e),
      request_id,
      code: 'E_EXCEPTION',
      client_id
    }).catch(() => {});
    
    return { statusCode: 500, body: JSON.stringify({ ok:false, message: String(e?.message||e) }) };
  }
};
