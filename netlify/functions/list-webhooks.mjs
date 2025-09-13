// netlify/functions/list-webhooks.mjs
const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body, null, 2),
});

const normShop = (s="") =>
  String(s).trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/[?#].*$/,"")
    .replace(/\/.*/,"").replace(/:\d+$/,"")
    .replace(/\.shopify\.com$/i, ".myshopify.com");

export const handler = async (event) => {
  try {
    const params = new URLSearchParams(event.rawQuery || "");
    const shop = normShop(params.get("shop") || "");
    const want = process.env.FORWARD_SECRET || "";
    const hdr  = Object.fromEntries(Object.entries(event.headers || {}).map(([k,v]) => [String(k).toLowerCase(), v]));
    const secret = params.get("secret") || hdr["x-seoboss-forward-secret"];

    if (!shop)  return json(400, { ok:false, error:"missing ?shop=<store>.myshopify.com" });
    if (!want)  return json(500, { ok:false, error:"FORWARD_SECRET not set" });
    if (secret !== want) return json(401, { ok:false, error:"bad secret" });

    // get decrypted token via your vault helper
    const base = (process.env.PUBLIC_BASE_URL || process.env.APP_URL || "").replace(/\/$/,"");
    const res  = await fetch(`${base}/.netlify/functions/get-shop-token?shop=${encodeURIComponent(shop)}`, {
      headers: { "X-SEOBOSS-FORWARD-SECRET": want }
    });
    if (!res.ok) return json(200, { ok:false, reason:"token_not_found", detail: await res.text() });
    const { token } = await res.json();
    if (!token?.startsWith("shpat_")) return json(200, { ok:false, reason:"bad_token" });

    // list current webhooks
    const api = `https://${shop}/admin/api/2024-10/webhooks.json`;
    const list = await fetch(api, { headers: { "X-Shopify-Access-Token": token } });
    if (!list.ok) return json(200, { ok:false, reason:"shopify_error", status:list.status, detail: await list.text() });

    const data = await list.json();
    const webhooks = (data.webhooks || []).map(w => ({
      id: w.id, topic: w.topic, address: w.address, created_at: w.created_at
    }));
    return json(200, { ok:true, shop, count: webhooks.length, webhooks });
  } catch (e) {
    return json(500, { ok:false, error: e.message || String(e) });
  }
};
