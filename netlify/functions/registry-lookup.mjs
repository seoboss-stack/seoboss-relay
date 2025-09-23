// POST or GET ?shop=xxx.myshopify.com  →  { client_id: "cli_..." }
export const handler = async (event) => {
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
    if (!r.ok) return { statusCode: r.status, body: await r.text() };
    const [row] = await r.json();
    if (!row) return { statusCode: 404, body: "not found" };

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: row.client_id }) };
  } catch {
    return { statusCode: 500, body: "error" };
  }
};
