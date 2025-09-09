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

// Shopify App Proxy signature:
// - remove "signature"
// - sort keys
// - if duplicate keys exist, join their values by comma
// - concat as key=value with NO separators between pairs
function verifyAppProxy(url, secret) {
  if (!secret) return false;

  const map = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (k === "signature") continue;
    if (!map[k]) map[k] = [];
    map[k].push(v);
  }
  const message = Object.keys(map)
    .sort()
    .map((k) => `${k}=${map[k].join(",")}`)
    .join("");

  const digest = crypto.createHmac("sha256", secret).update(message, "utf8").digest("hex");
  const sig = url.searchParams.get("signature") || "";
  try {
    return (
      sig.length === digest.length &&
      crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(sig, "hex"))
    );
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
  const SECRET =
    process.env.SHOPIFY_APP_SECRET_PUBLIC ||
    process.env.SHOPIFY_APP_SECRET ||
    "";
  if (!verifyAppProxy(url, SECRET)) {
    return json(401, { error: "bad signature" });
  }

  // 2) forward to n8n
  const base = (process.env.N8N_ENGINE_BASE_URL || process.env.N8N_ENGINE_WEBHOOK_URL || "").replace(/\/$/, "");
  if (!base) return json(500, { error: "missing N8N_ENGINE_BASE_URL" });

  // forward all query params EXCEPT signature
  const fwdQS = new URLSearchParams(url.searchParams);
  fwdQS.delete("signature");
  const qs = fwdQS.toString();
  const path = suffix === "/" ? "/run" : suffix;
  const target = `${base}${path}${qs ? `?${qs}` : ""}`;

  const method = event.httpMethod || "GET";
  const needsBody = ["POST", "PUT", "PATCH"].includes(method);
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");

  const headers = event.headers || {};
  const loggedInId = url.searchParams.get("logged_in_customer_id") || "";

  const resp = await fetch(target, {
    method,
    headers: {
      "Content-Type": headers["content-type"] || headers["Content-Type"] || "application/json",
      "X-Channel": "shopify-proxy",
      "X-Shop": url.searchParams.get("shop") || "",
      "X-Logged-In-Customer-Id": loggedInId,
      "X-Seoboss-Ts": String(Math.floor(Date.now() / 1000)),
      "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || "",
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
