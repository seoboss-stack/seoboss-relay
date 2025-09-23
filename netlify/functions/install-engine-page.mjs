import crypto from "node:crypto";
import { logFnError } from "./log.mjs";

const normShop = (s="") => String(s).trim().toLowerCase()
  .replace(/^https?:\/\//,"").replace(/[?#].*$/,"").replace(/\/.*/,"")
  .replace(/:\d+$/,"").replace(/\.shopify\.com$/i,".myshopify.com");

function ok(status, body){ return { statusCode: status, headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) }; }

export const handler = async (event) => {
  const request_id = event.headers?.["x-nf-request-id"] || "";
  try{
    if (event.httpMethod !== "POST") return ok(405, { ok:false, message:"POST only" });

    // Signed relay (you already use this pattern)
    const ts = event.headers["x-seoboss-ts"]; // optional freshness
    const secret = process.env.PUBLIC_HMAC_KEY || "";
    const bodyText = event.body || "";
    const hmac = event.headers["x-seoboss-hmac"] || "";
    if (secret){
      const expect = crypto.createHmac("sha256", secret).update(bodyText + "\n" + (ts||"")).digest("hex");
      if (expect.length !== hmac.length || !crypto.timingSafeEqual(Buffer.from(expect,"hex"), Buffer.from(hmac,"hex"))){
        return ok(401,{ ok:false, message:"bad signature" });
      }
    }

    const { shop: rawShop, client_id } = Object.fromEntries(new URLSearchParams(bodyText));
    const shop = normShop(rawShop);
    if (!shop || !client_id) return ok(400, { ok:false, message:"missing shop/client_id" });

    // 1) Get access token from your vault (your existing get-shop-token function)
    const vaultRes = await fetch(`${process.env.PUBLIC_BASE_URL || process.env.APP_URL}/.netlify/functions/get-shop-token`, {
      method:"POST",
      headers:{ "Content-Type":"application/json", "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || "" },
      body: JSON.stringify({ shop, client_id })
    });
    if (!vaultRes.ok) return ok(502,{ ok:false, message:"cannot load token" });
    const { token } = await vaultRes.json();

    // 2) Create/update a hidden page that iframes your App Proxy
    const api = `https://${shop}/admin/api/2024-10`;
    const headers = { "Content-Type":"application/json", "X-Shopify-Access-Token": token };

    const title = "SEOBoss Console";
    const handle = "seoboss-console";
    const body_html = `
      <div style="min-height:70vh">
        <iframe src="/apps/seoboss/page?shop=${shop}&client_id=${encodeURIComponent(client_id)}"
                style="width:100%;min-height:80vh;border:0" loading="lazy"></iframe>
      </div>`;

    // Try update by handle first
    let pageId = null;
    const find = await fetch(`${api}/pages.json?handle=${encodeURIComponent(handle)}&fields=id,handle,body_html,title`, { headers });
    if (find.ok){
      const pages = (await find.json())?.pages || [];
      if (pages.length){ pageId = pages[0].id; }
    }

    const payload = { page: { title, handle, body_html, published: true } };
    const rsp = await fetch(pageId ? `${api}/pages/${pageId}.json` : `${api}/pages.json`, {
      method: pageId ? "PUT" : "POST", headers, body: JSON.stringify(payload)
    });
    if (!rsp.ok) return ok(502, { ok:false, message:`page ${pageId?'update':'create'} failed: ${await rsp.text()}` });
    const page = (await rsp.json())?.page || {};
    const page_url = `https://${shop}/pages/${page.handle || handle}`;

    return ok(200, { ok:true, page_id: page.id, page_url });

  } catch (e){
    try{ await logFnError({ fn:"install-engine-page", status:500, message:e?.message || String(e), stack:e?.stack || null }); }catch{}
    return ok(500, { ok:false, message:"internal error" });
  }
};
