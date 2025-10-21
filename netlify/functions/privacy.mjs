// netlify/functions/privacy.mjs
import crypto from "node:crypto";
import { errlog } from './_lib/_errlog.mjs';  // ✅ ADD THIS

const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const toLowerHeaders = (h = {}) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [String(k).toLowerCase(), v]));

function safeEqualB64(aB64, bB64) {
  try {
    const A = Buffer.from(String(aB64 || ""), "base64");
    const B = Buffer.from(String(bB64 || ""), "base64");
    return A.length === B.length && crypto.timingSafeEqual(A, B);
  } catch { return false; }
}

export const handler = async (event) => {
  // ✅ ADD THIS - Extract request_id
  const request_id = event.headers?.["x-request-id"] || event.headers?.["X-Request-Id"] || 
                     event.headers?.["x-shopify-request-id"] || '';
  
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "POST only (Shopify webhooks)" });
  }

  const SECRET =
    process.env.SHOPIFY_APP_SECRET_PUBLIC ||
    process.env.SHOPIFY_APP_SECRET ||
    "";
    
  if (!SECRET) {
    // ✅ ADD THIS - Log missing secret (fire and forget)
    errlog({
      shop: '',
      route: '/privacy',
      status: 500,
      message: 'Shopify app secret not configured',
      detail: 'Cannot verify GDPR webhook HMAC',
      request_id,
      code: 'E_CONFIG'
    }).catch(() => {});
    
    return json(500, { ok: false, error: "missing app secret" });
  }

  // Raw body must match exactly what Shopify signed
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64")
    : Buffer.from(event.body || "", "utf8");

  const headers = toLowerHeaders(event.headers || {});
  const hmacHeader = headers["x-shopify-hmac-sha256"] || "";
  const topic = String(headers["x-shopify-topic"] || "").toLowerCase();
  const shopDomain = String(headers["x-shopify-shop-domain"] || "");

  const expectedB64 = crypto.createHmac("sha256", SECRET).update(raw).digest("base64");
  
  if (!safeEqualB64(expectedB64, hmacHeader)) {
    // ✅ ADD THIS - Log HMAC failures (could indicate security issue, fire and forget)
    errlog({
      shop: shopDomain,
      route: '/privacy',
      status: 401,
      message: 'GDPR webhook HMAC verification failed',
      detail: `topic: ${topic}, shop: ${shopDomain}`,
      request_id,
      code: 'E_HMAC_FAILED'
    }).catch(() => {});
    
    return json(401, { ok: false, error: "bad_hmac" });
  }

  // Optional: parse only after HMAC verified
  let payload = {};
  try { payload = JSON.parse(raw.toString("utf8") || "{}"); } catch {}

  // For GDPR topics, ACK fast; do slow/purge work asynchronously
  // Netlify allows outgoing fetches; keep them non-blocking where possible.
  try {
    if (topic === "shop/redact") {
      // Purge any shop-scoped data you store. We call your token deleter.
      const url = `${process.env.PUBLIC_BASE_URL || process.env.APP_URL}/.netlify/functions/delete-shop-token`;
      
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || "",
          "X-Request-Id": request_id,  // ✅ ADD THIS - Forward correlation ID
        },
        body: JSON.stringify({ shop: shopDomain || payload?.shop_domain || "" }),
      }).catch((err) => {
        // ✅ ADD THIS - Log token deletion failure (fire and forget)
        errlog({
          shop: shopDomain,
          route: '/privacy',
          status: 500,
          message: 'Failed to delete shop token during GDPR shop/redact',
          detail: err.message || String(err),
          request_id,
          code: 'E_GDPR_SHOP_REDACT'
        }).catch(() => {});
      });
      
      // If you keep any config rows in Sheets/Supabase, queue deletions here too.
      
    } else if (topic === "customers/redact") {
      // If you ever store customer-level data, purge it here.
      // Currently SEOBOSS doesn't store customers: nothing to do.
      
    } else if (topic === "customers/data_request") {
      // If you store customer data, you may need to assemble a report for the merchant.
      // Currently nothing stored → acknowledge.
    }
  } catch (e) {
    // ✅ ADD THIS - Log unexpected GDPR processing errors (fire and forget)
    errlog({
      shop: shopDomain,
      route: '/privacy',
      status: 500,
      message: 'Exception during GDPR webhook processing',
      detail: `topic: ${topic}, error: ${e.message || String(e)}`,
      request_id,
      code: 'E_GDPR_PROCESSING'
    }).catch(() => {});
    /* never block webhook */
  }

  return json(200, { ok: true, topic });
};
