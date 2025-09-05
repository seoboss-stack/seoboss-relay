// netlify/functions/engine-proxy.mjs
import crypto from "node:crypto";

const ORIGIN = "https://seoboss.com"; // CORS for your UI

function json(status, data) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ORIGIN,
      "Access-Control-Expose-Headers": "Content-Type",
    },
    body: JSON.stringify(data),
  };
}

function getSuffix(url) {
  // Strip function mount or /proxy prefix once
  let p = url.pathname;
  p = p.replace(/^\/\.netlify\/functions\/engine-proxy/, "");
  p = p.replace(/^\/proxy/, "");
  return p || "/";
}

function verifyAppProxy(url, secret) {
  if (!secret) return false;
  // App Proxy signs all query params except `signature`
  const pairs = [];
  url.searchParams.forEach((v, k) => {
    if (k !== "signature") pairs.push([k, v]);
  });
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const message = pairs.map(([k, v]) => `${k}=${v}`).join(""); // no separators
  const digest = crypto.createHmac("sha256", secret).update(message, "utf8").digest("hex");
  const sig = url.searchParams.get("signature") || "";
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}

export const handler = async (event) => {
  const url = new URL(event.rawUrl);
  const suffix = getSuffix(url);

  // 0) health check (no signature)
  if (suffix === "/_alive") {
    return json(200, { ok: true, service: "engine-proxy", t: Date.now() });
  }

  // 1) verify Shopify App Proxy signature
  if (!verifyAppProxy(url, process.env.SHOPIFY_APP_SECRET)) {
    return json(401, { error: "bad signature" });
  }

  // 2) forward to n8n
  const base = (process.env.N8N_ENGINE_BASE_URL || process.env.N8N_ENGINE_WEBHOOK_URL || "").replace(/\/$/, "");
  if (!base) return json(500, { error: "missing N8N_ENGINE_BASE_URL" });

  const target = `${base}${suffix === "/" ? "/run" : suffix}`;
  const method = event.httpMethod || "GET";
  const needsBody = ["POST", "PUT", "PATCH"].includes(method);
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");

  const resp = await fetch(target, {
    method,
    headers: {
      "Content-Type": event.headers?.["content-type"] || "application/json",
      "X-Channel": "shopify-proxy",
      "X-Shop": url.searchParams.get("shop") || "",
      "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || "",
      "X-Seoboss-Ts": String(Math.floor(Date.now() / 1000)),
    },
    body: needsBody ? rawBody : undefined,
  });

  const text = await resp.text();
  return {
    statusCode: resp.status,
    headers: {
      "Content-Type": resp.headers.get("content-type") || "application/json",
      "Access-Control-Allow-Origin": ORIGIN,
      "Access-Control-Expose-Headers": "Content-Type",
    },
    body: text,
  };
};
