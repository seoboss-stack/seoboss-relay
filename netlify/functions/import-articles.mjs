// netlify/functions/import-articles.mjs
import crypto from "node:crypto";

function canonicalForm(obj){
  return Object.entries(obj||{})
    .filter(([,v]) => v !== undefined && v !== null && String(v).trim() !== "")
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v))).join("&");
}

export const handler = async (event) => {
  try{
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST only" };

    const FWD_SECRET = process.env.FORWARD_SECRET || "";
    const PUBLIC_HMAC_KEY = process.env.PUBLIC_HMAC_KEY || "";
    const N8N_IMPORT_URL = process.env.N8N_IMPORT_ARTICLES_URL; // e.g. https://.../webhook/seoboss/api/shop/import-articles
    if (!FWD_SECRET || !PUBLIC_HMAC_KEY || !N8N_IMPORT_URL) {
      return { statusCode: 500, body: "missing env FORWARD_SECRET/PUBLIC_HMAC_KEY/N8N_IMPORT_ARTICLES_URL" };
    }

    const params = new URLSearchParams(event.body || "");
    const client_id = (params.get("client_id") || "").trim();
    const shop = (params.get("shop") || "").trim().toLowerCase();

    const body = canonicalForm({ client_id, shop });
    const ts = Math.floor(Date.now()/1000).toString();
    const sig = crypto.createHmac("sha256", PUBLIC_HMAC_KEY).update(body + "\n" + ts).digest("hex");

    const rsp = await fetch(N8N_IMPORT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Seoboss-Ts": ts,
        "X-Seoboss-Hmac": sig,
        "X-Seoboss-Key-Id": "global",
        "X-SEOBOSS-FORWARD-SECRET": FWD_SECRET
      },
      body
    });

    const text = await rsp.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw:text }; }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: rsp.ok, stats: data?.stats || null })
    };
  }catch(e){
    return { statusCode: 500, body: JSON.stringify({ ok:false, message: String(e?.message||e) }) };
  }
};
