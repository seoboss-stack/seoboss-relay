import fetch from "node-fetch";

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST only" };

  const FWD = process.env.FORWARD_SECRET || "";
  if (!FWD || event.headers["x-seoboss-forward-secret"] !== FWD) {
    return { statusCode: 401, body: "forbidden" };
  }

  const { client_id = "", shop = "" } = JSON.parse(event.body || "{}");
  if (!client_id && !shop) return { statusCode: 400, body: "client_id or shop required" };

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { statusCode: 500, body: "missing env" };

  const filter = client_id
    ? `client_id=eq.${encodeURIComponent(client_id)}`
    : `shop=eq.${encodeURIComponent(shop)}`;

  const rsp = await fetch(`${url}/rest/v1/encrypted_shop_tokens?${filter}`, {
    method: "DELETE",
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });

  return { statusCode: rsp.ok ? 200 : rsp.status, body: rsp.ok ? "ok" : await rsp.text() };
};
