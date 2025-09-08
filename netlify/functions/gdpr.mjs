// netlify/functions/gdpr.mjs
import crypto from "node:crypto";

function ok() { return { statusCode: 200, body: "ok" }; }
function bad() { return { statusCode: 401, body: "bad hmac" }; }

export const handler = async (event) => {
  // 1) Verify Shopify webhook HMAC (base64 of sha256 over RAW body)
  const secret = process.env.SHOPIFY_APP_SECRET || "";
  const hdr = event.headers || {};
  const sent = hdr["x-shopify-hmac-sha256"] || hdr["X-Shopify-Hmac-Sha256"];
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64")
    : Buffer.from(event.body || "", "utf8");

  const digest = crypto.createHmac("sha256", secret).update(raw).digest("base64");
  if (!sent || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(digest))) return bad();

  // 2) Route by topic (you can log/do real deletes here)
  const topic = (hdr["x-shopify-topic"] || "").toLowerCase();
  // const payload = JSON.parse(raw.toString("utf8")); // if you need it
  switch (topic) {
    case "customers/data_request":
      // TODO: look up customer’s data & respond to merchant off-platform if needed.
      return ok();
    case "customers/redact":
      // TODO: delete/anonymize any customer data you store.
      return ok();
    case "shop/redact":
      // TODO: purge all data for the shop (on uninstall/24h after).
      return ok();
    default:
      return ok();
  }
};
