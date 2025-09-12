// netlify/functions/delete-shop-token.mjs
import { logFnError } from "./log.mjs";

const normShop = (s="") => String(s).trim().toLowerCase()
  .replace(/^https?:\/\//,"").replace(/[?#].*$/,"").replace(/\/.*/,"")
  .replace(/:\d+$/,"").replace(/\.shopify\.com$/i,".myshopify.com");

export const handler = async (event) => {
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

    const filter = client_id
      ? `client_id=eq.${encodeURIComponent(client_id)}`
      : `shop=eq.${encodeURIComponent(normShop(rawShop))}`;

    const rsp = await fetch(`${url}/rest/v1/encrypted_shop_tokens?${filter}`, {
      method: "DELETE",
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (!rsp.ok) return { statusCode: rsp.status, body: await rsp.text() };
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    try { await logFnError({ fn: "delete-shop-token", status: 500, message: String(e) }); } catch {}
    return { statusCode: 500, body: "internal error" };
  }
};
