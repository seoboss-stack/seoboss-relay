export const handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST only" };

    const FWD = process.env.FORWARD_SECRET || "";
    const got = event.headers["x-seoboss-forward-secret"] || event.headers["X-Seoboss-Forward-Secret"] || "";
    if (!FWD || got !== FWD) return { statusCode: 401, body: "forbidden" };

    const { shop = "", client_id = "" } = JSON.parse(event.body || "{}");
    if (!shop) return { statusCode: 400, body: "missing shop" };

    // 1) admin token via your existing function
    const tokRsp = await fetch(`${process.env.PUBLIC_BASE_URL}/.netlify/functions/get-shop-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SEOBOSS-FORWARD-SECRET": FWD },
      body: JSON.stringify({ shop })
    });
    if (!tokRsp.ok) return { statusCode: 502, body: `token err: ${await tokRsp.text()}` };
    const { token } = await tokRsp.json();

    // 2) create page
    const qs = new URLSearchParams({ shop }); if (client_id) qs.set("client_id", client_id);
    const iframeSrc = `/apps/seoboss/page?${qs.toString()}`;

    const api = `https://${shop}/admin/api/2024-10/pages.json`;
    const body = {
      page: {
        title: "SEOBoss Engine",
        handle: "seoboss-engine",
        body_html: `<div style="min-height:80vh"><iframe src="${iframeSrc}" style="width:100%;height:80vh;border:0"></iframe></div>`,
        published: true,
      }
    };

    const pr = await fetch(api, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify(body)
    });
    if (!pr.ok) return { statusCode: pr.status, body: await pr.text() };
    const out = await pr.json();

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, page: out.page }) };
  } catch {
    return { statusCode: 500, body: "internal error" };
  }
};
