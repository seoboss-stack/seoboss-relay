// netlify/functions/privacy.mjs
import crypto from "node:crypto";

function safeEqualB64(aB64, bB64) {
  if (!aB64 || !bB64) return false;
  let A, B;
  try {
    A = Buffer.from(String(aB64), "base64");
    B = Buffer.from(String(bB64), "base64");
  } catch {
    return false;
  }
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export const handler = async (event) => {
  // Webhooks are POST-only
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "POST only (Shopify webhooks)" });
  }

  const SECRET =
    process.env.SHOPIFY_APP_SECRET_PUBLIC ||
    process.env.SHOPIFY_APP_SECRET ||
    "";

  if (!SECRET) return json(500, { ok: false, error: "missing app secret" });

  // Raw body (must match exactly what Shopify signed)
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64")
    : Buffer.from(event.body || "", "utf8");

  const hmacHeader =
    event.headers["x-shopify-hmac-sha256"] ||
    event.headers["X-Shopify-Hmac-Sha256"] ||
    "";

  if (!hmacHeader) return json(401, { ok: false, error: "missing_hmac" });

  const expectedB64 = crypto.createHmac("sha256", SECRET).update(raw).digest("base64");
  if (!safeEqualB64(expectedB64, hmacHeader)) {
    return json(401, { ok: false, error: "bad_hmac" });
  }

  const topic = (event.headers["x-shopify-topic"] || event.headers["X-Shopify-Topic"] || "").toLowerCase();
  // You can optionally parse the body:
  // const payload = JSON.parse(raw.toString("utf8") || "{}");

  // Do whatever you need per-topic, but *always* return quickly (<=3s)
  // For privacy topics we just ACK.
  switch (topic) {
    case "customers/redact":
    case "customers/data_request":
    case "shop/redact":
      return json(200, { ok: true, topic });
    default:
      // Non-privacy webhooks hitting this endpoint by mistake
      return json(200, { ok: true, topic });
  }
};
