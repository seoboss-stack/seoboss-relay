// netlify/functions/uninstalled.mjs
import crypto from "node:crypto";
import { errlog } from './_lib/_errlog.mjs';  // ✅ ADD THIS

const json = (s, b) => ({
  statusCode: s,
  headers: { "Content-Type": "application/json" },
  body: typeof b === "string" ? b : JSON.stringify(b),
});

const lower = (h = {}) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [String(k).toLowerCase(), v]));

const safeHmac = (raw, secret, sentB64) => {
  if (!secret || !sentB64) return false;
  const want = crypto.createHmac("sha256", secret).update(raw).digest("base64");
  try {
    const A = Buffer.from(want, "base64");
    const B = Buffer.from(String(sentB64), "base64");
    return A.length === B.length && crypto.timingSafeEqual(A, B);
  } catch { return false; }
};

export const handler = async (event) => {
  // ✅ ADD THIS - Extract request_id
  const request_id = event.headers?.["x-request-id"] || event.headers?.["X-Request-Id"] || '';
  
  if (event.httpMethod !== "POST") return json(405, "POST only");

  const SECRET =
    process.env.SHOPIFY_APP_SECRET_PUBLIC ||
    process.env.SHOPIFY_APP_SECRET || "";
  const FWD = process.env.FORWARD_SECRET || "";
  const N8N_URL = process.env.N8N_SHOP_DEACTIVATE_URL || process.env.N8N_ONBOARD_SUBMIT_URL || "";

  if (!SECRET) return json(500, "missing secret");

  const headers = lower(event.headers || {});
  const topic = String(headers["x-shopify-topic"] || "").toLowerCase();
  const sent  = headers["x-shopify-hmac-sha256"] || "";
  const raw   = event.isBase64Encoded ? Buffer.from(event.body || "", "base64")
                                      : Buffer.from(event.body || "", "utf8");

  if (!safeHmac(raw, SECRET, sent)) return json(401, "bad hmac");
  if (topic !== "app/uninstalled")  return json(200, "ok (ignored topic)");

  // Parse payload AFTER HMAC passes (optional; headers usually include shop)
  let payload = {};
  try { payload = JSON.parse(raw.toString("utf8") || "{}"); } catch {}

  const shop =
    headers["x-shopify-shop-domain"] ||
    payload?.myshopify_domain ||
    payload?.shop_domain ||
    "";

  // 1) Purge token immediately (idempotent, best-effort, non-blocking)
  try {
    const base = (process.env.PUBLIC_BASE_URL || process.env.APP_URL || "").replace(/\/$/, "");
    const resp = await fetch(`${base}/.netlify/functions/delete-shop-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SEOBOSS-FORWARD-SECRET": FWD,
      },
      body: JSON.stringify({ shop }),
    });
    
    // ✅ ADD THIS - Log if token deletion failed (but don't block ACK)
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => 'unknown');
      errlog({
        shop,
        route: '/uninstalled',
        status: resp.status,
        message: 'Failed to delete shop token on uninstall',
        detail: errorText,
        request_id,
        code: 'E_TOKEN_DELETE_FAILED'
      }).catch(() => {}); // Fire and forget - don't block Shopify ACK
    }
  } catch (err) {
    // ✅ ADD THIS - Log fetch failure (but don't block ACK)
    errlog({
      shop,
      route: '/uninstalled',
      status: 500,
      message: 'Exception while deleting shop token on uninstall',
      detail: err.message || String(err),
      request_id,
      code: 'E_TOKEN_DELETE_EXCEPTION'
    }).catch(() => {}); // Fire and forget
  }

  // 2) Notify n8n for bookkeeping (status flags, logs, emails, etc.)
  try {
    if (N8N_URL) {
      const resp = await fetch(N8N_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SEOBOSS-FORWARD-SECRET": FWD,
          "X-Request-Id": request_id,  // ✅ ADD THIS - Forward correlation ID
        },
        body: JSON.stringify({
          op: "deactivate_shop",     // <- consistent op
          shop,                      // <- consistent field
          shop_url: shop,            // <- keep your legacy field too
          topic,
          uninstalled_at: new Date().toISOString(),
        }),
      });
      
      // ✅ ADD THIS - Log if n8n notification failed (but don't block ACK)
      if (!resp.ok) {
        const errorText = await resp.text().catch(() => 'unknown');
        errlog({
          shop,
          route: '/uninstalled',
          status: resp.status,
          message: 'Failed to notify n8n of uninstall',
          detail: errorText,
          request_id,
          code: 'E_N8N_NOTIFICATION_FAILED'
        }).catch(() => {}); // Fire and forget
      }
    }
  } catch (err) {
    // ✅ ADD THIS - Log fetch failure (but don't block ACK)
    errlog({
      shop,
      route: '/uninstalled',
      status: 500,
      message: 'Exception while notifying n8n of uninstall',
      detail: err.message || String(err),
      request_id,
      code: 'E_N8N_NOTIFICATION_EXCEPTION'
    }).catch(() => {}); // Fire and forget
  }

  // ACK fast so Shopify doesn't retry
  return json(200, { ok: true, shop, topic });
};
