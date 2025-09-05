// Shopify App Proxy verifier + forwarder (safe-mode)
import crypto from "node:crypto";

function ok(status, body, extra={}) {
  return { statusCode: status, headers: { "Content-Type": "application/json; charset=utf-8", ...extra }, body: JSON.stringify(body) };
}
function verifyShopifyProxy(qs, secret) {
  // App Proxy sends ?shop=...&timestamp=...&signature=...
  const { signature, ...rest } = qs || {};
  if (!signature || !secret) return false;
  const base = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join("");
  const dig  = crypto.createHmac("sha256", secret).update(base, "utf8").digest("hex");
  try {
    const a = Buffer.from(String(signature), "hex");
    const b = Buffer.from(dig, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

export const handler = async (event) => {
  // health check path (no signature) so you can verify deploy first
  const suffix = (event.path || "").replace(/^.*engine-proxy/, "") || "/";
  if (suffix === "/_alive") return ok(200, { ok: true, service: "engine-proxy", version: "1" });

  // verify Shopify App Proxy signature
  const qs = event.queryStringParameters || {};
  if (!verifyShopifyProxy(qs, process.env.SHOPIFY_APP_SECRET)) {
    return ok(401, { error: "bad signature" });
  }

  // identify shop + (optional) registry lookup (stub for now)
  const shop = qs.shop || "";
  const registry = { client_id: "cli_demo", sheet_id: "sheet_123", status: "active" };
  if (registry.status !== "active") return ok(403, { error: "inactive" });

  // forward to n8n (preserve subpath after /proxy/*)
  const base = (process.env.N8N_ENGINE_BASE_URL || process.env.N8N_ENGINE_WEBHOOK_URL || "").replace(/\/$/, "");
  const target = base + (suffix || "/run");

  const method = event.httpMethod || "GET";
  const passBody = ["POST","PUT","PATCH"].includes(method);
  const raw = event.isBase64Encoded ? Buffer.from(event.body||"", "base64").toString("utf8") : (event.body||"");

  const ts = Math.floor(Date.now()/1000);
  const res = await fetch(target, {
    method,
    headers: {
      "Content-Type": event.headers?.["content-type"] || "application/json",
      "X-Channel": "shopify-proxy",
      "X-Shop": shop,
      "X-Client-Id": registry.client_id,
      "X-Sheet-Id": registry.sheet_id,
      "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || "",
      "X-Seoboss-Ts": String(ts)
    },
    body: passBody ? raw : undefined
  });

  const text = await res.text();
  return { statusCode: res.status, headers: { "Content-Type": res.headers.get("content-type") || "application/json" }, body: text };
};
