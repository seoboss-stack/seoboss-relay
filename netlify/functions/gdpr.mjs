// netlify/functions/gdpr.mjs
import crypto from "node:crypto";
import { errlog } from './_lib/_errlog.mjs';  // ✅ ADD THIS

const ok  = () => ({ statusCode: 200, body: "ok" });
const bad = () => ({ statusCode: 401, body: "bad hmac" });

const headersLower = (h = {}) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

export const handler = async (event) => {
  // ✅ ADD THIS - Extract request_id
  const request_id = event.headers?.["x-request-id"] || event.headers?.["X-Request-Id"] || 
                     event.headers?.["x-shopify-request-id"] || '';
  
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST only" };

  // 1) Verify Shopify webhook HMAC (base64 of sha256 over RAW body)
  const secret =
    process.env.SHOPIFY_APP_SECRET_PUBLIC ||
    process.env.SHOPIFY_APP_SECRET || "";
    
  if (!secret) {
    // ✅ ADD THIS - Log missing secret (fire and forget)
    errlog({
      shop: '',
      route: '/gdpr',
      status: 500,
      message: 'Shopify app secret not configured',
      detail: 'Cannot verify GDPR webhook HMAC',
      request_id,
      code: 'E_CONFIG'
    }).catch(() => {});
    
    return { statusCode: 500, body: "missing app secret" };
  }

  const hdr = headersLower(event.headers || {});
  const sent = hdr["x-shopify-hmac-sha256"];
  const shopDomain = hdr["x-shopify-shop-domain"] || '';
  const topic = (hdr["x-shopify-topic"] || "").toLowerCase();
  
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64")
    : Buffer.from(event.body || "", "utf8");

  const digestB64 = crypto.createHmac("sha256", secret).update(raw).digest("base64");

  // Decode BOTH sides from base64, then timing-safe compare
  try {
    if (!sent || !crypto.timingSafeEqual(Buffer.from(sent, "base64"), Buffer.from(digestB64, "base64"))) {
      // ✅ ADD THIS - Log HMAC failures (fire and forget)
      errlog({
        shop: shopDomain,
        route: '/gdpr',
        status: 401,
        message: 'GDPR webhook HMAC verification failed',
        detail: `topic: ${topic}, shop: ${shopDomain}`,
        request_id,
        code: 'E_HMAC_FAILED'
      }).catch(() => {});
      
      return bad();
    }
  } catch (err) {
    // ✅ ADD THIS - Log HMAC comparison errors (fire and forget)
    errlog({
      shop: shopDomain,
      route: '/gdpr',
      status: 500,
      message: 'HMAC comparison threw exception',
      detail: `topic: ${topic}, error: ${err.message}`,
      request_id,
      code: 'E_HMAC_EXCEPTION'
    }).catch(() => {});
    
    return bad();
  }

  // 2) Route by topic
  // const payload = JSON.parse(raw.toString("utf8")); // if you need it

  switch (topic) {
    case "customers/data_request":
      // TODO: respond off-platform to merchant if needed.
      return ok();
      
    case "customers/redact":
      // TODO: delete/anonymize any customer data you store.
      return ok();
      
    case "shop/redact":
      // TODO: purge all shop data within the required window.
      // Note: privacy.mjs handles this with delete-shop-token call
      return ok();
      
    default:
      // Not a GDPR topic you care about -> still 200 OK
      return ok();
  }
};
