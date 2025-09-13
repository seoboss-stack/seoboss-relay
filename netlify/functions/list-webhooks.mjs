// netlify/functions/list-webhooks.mjs
const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body, null, 2),
});

const lower = (h = {}) => Object.fromEntries(
  Object.entries(h).map(([k, v]) => [String(k).toLowerCase(), v])
);

const normShop = (s = "") =>
  String(s).trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/[?#].*$/, "")
    .replace(/\/.*/, "").replace(/:\d+$/, "")
    .replace(/\.shopify\.com$/i, ".myshopify.com");

async function getVaultToken(shop, wantSecret) {
  const base = (process.env.PUBLIC_BASE_URL || process.env.APP_URL || "").replace(/\/$/, "");
  const res = await fetch(`${base}/.netlify/functions/get-shop-token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SEOBOSS-FORWARD-SECRET": wantSecret,
    },
    body: JSON.stringify({ shop }),
  });
  if (!res.ok) throw new Error(`get-shop-token: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const token = String(data.token || "");
  if (!token.startsWith("shpat_")) throw new Error("vault: no shpat token");
  return token;
}

export const handler = async (event) => {
  try {
    const params = new URLSearchParams(event.rawQuery || "");
    const hdr = lower(event.headers || {});
    const shop = normShop(params.get("shop") || "");
    const want = process.env.FORWARD_SECRET || "";
    const secret = params.get("secret") || hdr["x-seoboss-forward-secret"];

    if (!shop) return json(400, { ok: false, error: "missing ?shop=<store>.myshopify.com" });
    if (!want) return json(500, { ok: false, error: "FORWARD_SECRET not set" });
    if (secret !== want) return json(401, { ok: false, error: "bad secret" });

    // POST to your vault helper (previously caused "POST only")
    let token;
    try {
      token = await getVaultToken(shop, want);
    } catch (e) {
      return json(200, { ok: false, reason: "token_not_found", detail: String(e.message || e) });
    }

    const api = `https://${shop}/admin/api/2024-10/webhooks.json`;
    const res = await fetch(api, { headers: { "X-Shopify-Access-Token": token } });
    if (!res.ok) {
      return json(200, { ok: false, reason: "shopify_error", status: res.status, detail: await res.text() });
    }

    const data = await res.json();
    const webhooks = (data.webhooks || []).map(w => ({
      id: w.id, topic: w.topic, address: w.address, created_at: w.created_at
    }));
    return json(200, { ok: true, shop, count: webhooks.length, webhooks });
  } catch (e) {
    return json(500, { ok: false, error: e.message || String(e) });
  }
};
