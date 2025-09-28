// netlify/functions/engine-proxy.mjs
// Node 20 has global fetch; no import needed.
import crypto from "node:crypto";

const ORIGIN = process.env.URL || process.env.DEPLOY_URL || "https://seoboss.com"; // CORS for your UI

function corsHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Requested-With, X-Client-ID",
    "Access-Control-Expose-Headers": "Content-Type, X-SeoBoss-Backend",
    ...extra,
  };
}

function json(status, data, extraHeaders = {}) {
  return { statusCode: status, headers: corsHeaders(extraHeaders), body: JSON.stringify(data) };
}

function getSuffix(eventPath) {
  // Works for both /apps/engine/... (via redirect) and /proxy/...
  let p = eventPath || "/";
  p = p.replace(/^\/\.netlify\/functions\/engine-proxy/, "");
  p = p.replace(/^\/apps\/engine/, "");
  p = p.replace(/^\/proxy/, "");
  return p || "/";
}

// Build message per Shopify App Proxy rule:
// - exclude "signature"
// - sort keys
// - join duplicate values with commas
// - concat k=v with NO separators
function makeProxyMessage(url) {
  const map = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (k === "signature") continue;
    (map[k] ||= []).push(v);
  }
  return Object.keys(map)
    .sort()
    .map((k) => `${k}=${map[k].join(",")}`)
    .join("");
}

function verifyWithSecret(url, secret) {
  if (!secret) return false;
  const message = makeProxyMessage(url);
  const digest = crypto.createHmac("sha256", secret).update(message, "utf8").digest("hex");
  const sig = url.searchParams.get("signature") || "";
  try {
    return sig.length === digest.length &&
      crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}

// Map certain endpoints to internal Netlify functions
// Key = suffix after /apps/engine or /proxy
const FUNCTION_ROUTES = {
  "keywords": "/.netlify/functions/keywords",
  // add more when ready:
  // "hints": "/.netlify/functions/hints",
  // "blog-titles": "/.netlify/functions/blog-titles",
  // "blog-post": "/.netlify/functions/blog-post",
};

export const handler = async (event) => {
  // Handle OPTIONS preflight early
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  const url = new URL(event.rawUrl);
  const suffix = getSuffix(event.path);

  // 0) health check
  if (suffix === "/_alive") {
    return json(200, { ok: true, service: "engine-proxy", t: Date.now() }, { "X-SeoBoss-Backend": "engine-proxy" });
  }

  // 1) verify using EITHER secret (public or private app)
  const secrets = [
    process.env.SHOPIFY_APP_SECRET || "",
    process.env.SHOPIFY_APP_SECRET_PUBLIC || "",
  ];
  const ok = secrets.some((s) => verifyWithSecret(url, s));
  if (!ok) return json(401, { error: "bad signature" });

  // 2) Decide destination
  // Trim leading slash: "/keywords" -> "keywords"
  const key = suffix.replace(/^\//, "");
  const functionPath = FUNCTION_ROUTES[key];

  const method = event.httpMethod || "GET";
  const needsBody = ["POST", "PUT", "PATCH"].includes(method);
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");
  const passthroughHeaders = {
    "Content-Type": event.headers?.["content-type"] || event.headers?.["Content-Type"] || "application/json",
    "X-Channel": "shopify-proxy",
    "X-Shop": url.searchParams.get("shop") || "",
    "X-Logged-In-Customer-Id": url.searchParams.get("logged_in_customer_id") || "",
    "X-Seoboss-Ts": String(Math.floor(Date.now() / 1000)),
  };

  try {
    if (functionPath) {
      // ---- Forward to Netlify Function (e.g., keywords) ----
      const target = `${(process.env.URL || process.env.DEPLOY_URL || "").replace(/\/$/, "")}${functionPath}`;
      const res = await fetch(target, { method, headers: passthroughHeaders, body: needsBody ? rawBody : undefined });
      const text = await res.text();
      return {
        statusCode: res.status,
        headers: corsHeaders({ "X-SeoBoss-Backend": `engine-proxy -> ${key}` }),
        body: text,
      };
    }

    // ---- Default: forward to n8n ----
    const base = (process.env.N8N_ENGINE_BASE_URL || process.env.N8N_ENGINE_WEBHOOK_URL || "").replace(/\/$/, "");
    if (!base) return json(500, { error: "missing N8N_ENGINE_BASE_URL" });

    // pass through all query params except signature
    const qs = new URLSearchParams(url.searchParams);
    qs.delete("signature");
    const path = suffix === "/" ? "/run" : suffix;
    const target = `${base}${path}${qs.toString() ? `?${qs}` : ""}`;

    const resp = await fetch(target, { method, headers: { ...passthroughHeaders, "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET || "" }, body: needsBody ? rawBody : undefined });
    const text = await resp.text();

    return {
      statusCode: resp.status,
      headers: corsHeaders({ "X-SeoBoss-Backend": `engine-proxy -> n8n ${path}` }),
      body: text,
    };
  } catch (err) {
    return json(500, { error: String(err?.message || err) });
  }
};
