// GET /.netlify/functions/list-blogs?shop=<store>.myshopify.com
const ALLOW_ORIGIN = "https://seoboss.com"; // your connect page origin

const cors = () => ({
  "Access-Control-Allow-Origin": ALLOW_ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

const normShop = s => String(s||"").trim().toLowerCase()
  .replace(/^https?:\/\//,"").replace(/[?#].*$/,"").replace(/\/.*/,"")
  .replace(/:\d+$/,"").replace(/\.shopify\.com$/i,".myshopify.com");

async function getVaultToken(shop){
  const base=(process.env.PUBLIC_BASE_URL||process.env.APP_URL||"").replace(/\/$/,"");
  const res=await fetch(`${base}/.netlify/functions/get-shop-token`,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || ""
    },
    body: JSON.stringify({ shop })
  });
  if(!res.ok) throw new Error(`vault ${res.status}: ${await res.text()}`);
  const { token } = await res.json();
  if(!String(token).startsWith("shpat_")) throw new Error("no token");
  return token;
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: cors(), body: "GET only" };
  }
  try {
    const shop = normShop(new URL(event.rawUrl).searchParams.get("shop"));
    if (!shop) return { statusCode: 400, headers: cors(), body: "missing shop" };

    const token = await getVaultToken(shop);
    const resp = await fetch(`https://${shop}/admin/api/2024-10/blogs.json`, {
      headers: { "X-Shopify-Access-Token": token }
    });
    const body = await resp.json();
    if (!resp.ok) {
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok:false, error: body }) };
    }
    const blogs = (body.blogs || []).map(b => ({ id: String(b.id), title: b.title }));
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok:true, shop, blogs }) };
  } catch (e) {
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok:false, error: String(e.message||e) }) };
  }
};
