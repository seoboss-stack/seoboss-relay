// netlify/functions/ensure-webhooks.mjs
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

function publicBaseUrl(event) {
  const env = process.env.PUBLIC_BASE_URL || process.env.APP_URL || "";
  if (env) return env.replace(/\/$/, "");
  const proto = event.headers?.["x-forwarded-proto"] || "https";
  const host  = event.headers?.["x-forwarded-host"] || event.headers?.host || "";
  return `${proto}://${host}`;
}

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

async function listWebhooks(shop, token) {
  const res = await fetch(`https://${shop}/admin/api/2024-10/webhooks.json`, {
    headers: { "X-Shopify-Access-Token": token }
  });
  if (!res.ok) throw new Error(`list webhooks: ${res.status} ${await res.text()}`);
  return (await res.json()).webhooks || [];
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

    const baseUrl = publicBaseUrl(event);
    let token;
    try {
      token = await getVaultToken(shop, want);
    } catch (e) {
      return json(200, { ok: false, reason: "token_not_found", detail: String(e.message || e) });
    }

    const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": token };
    const apiBase = `https://${shop}/admin/api/2024-10`;

    const targets = [
      { topic: "app/uninstalled",        address: `${baseUrl}/.netlify/functions/uninstalled` },
      { topic: "customers/data_request", address: `${baseUrl}/.netlify/functions/privacy` },
      { topic: "customers/redact",       address: `${baseUrl}/.netlify/functions/privacy` },
      { topic: "shop/redact",            address: `${baseUrl}/.netlify/functions/privacy` },
    ];

    const existing = await listWebhooks(shop, token);
    const created = [];
    for (const { topic, address } of targets) {
      const already = existing.some(w => w.topic === topic && w.address === address);
      if (already) continue;
      const res = await fetch(`${apiBase}/webhooks.json`, {
        method: "POST", headers, body: JSON.stringify({ webhook: { topic, address, format: "json" } }),
      });
      if (!res.ok) throw new Error(`create ${topic}: ${res.status} ${await res.text()}`);
      created.push(topic);
    }
    const final = await listWebhooks(shop, token);
    return json(200, { ok: true, shop, baseUrl, created, count: final.length, webhooks: final });
  } catch (e) {
    return json(500, { ok: false, error: e.message || String(e) });
  }
};
