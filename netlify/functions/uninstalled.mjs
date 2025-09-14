// netlify/functions/uninstalled.mjs
import crypto from "node:crypto";

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
    await fetch(`${base}/.netlify/functions/delete-shop-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SEOBOSS-FORWARD-SECRET": FWD,
      },
      body: JSON.stringify({ shop }),
    });
  } catch (_) { /* do not block ACK */ }

  // 2) Notify n8n for bookkeeping (status flags, logs, emails, etc.)
  try {
    if (N8N_URL) {
      await fetch(N8N_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SEOBOSS-FORWARD-SECRET": FWD,
        },
        body: JSON.stringify({
          op: "deactivate_shop",     // <- consistent op
          shop,                      // <- consistent field
          shop_url: shop,            // <- keep your legacy field too
          topic,
          uninstalled_at: new Date().toISOString(),
        }),
      });
    }
  } catch (_) { /* do not block ACK */ }

  // ACK fast so Shopify doesn't retry
  return json(200, { ok: true, shop, topic });
};
