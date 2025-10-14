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
  let p = url.pathname;
  p = p.replace(/^\/\.netlify\/functions\/engine-proxy/, "");
  p = p.replace(/^\/proxy/, "");
  return p || "/";
}

// Build message per Shopify App Proxy rule
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

  // 0) health check
  if (suffix === "/_alive") {
    return json(200, { ok: true, service: "engine-proxy", t: Date.now() });
  }

  // 1) verify App Proxy signature (public or private app secret)
  const secrets = [
    process.env.SHOPIFY_APP_SECRET || "",
    process.env.SHOPIFY_APP_SECRET_PUBLIC || "",
  ];
  const ok = secrets.some((s) => verifyWithSecret(url, s));
  if (!ok) return json(401, { error: "bad signature" });

  /* ─────────────────────────────────────────────────────────────
     VAULT INTERCEPTOR (failsafe):
     If the path is /v3/vault/*, forward internally to your vault
     Netlify functions instead of n8n.
     This works regardless of whether Shopify forwards via /proxy
     or root—because engine-proxy sits on /proxy/*.
     ───────────────────────────────────────────────────────────── */
  const forwardToFunction = async (fnName) => {
    const qs = new URLSearchParams(url.searchParams); // keep shop, logged_in_customer_id, etc.
    // Keep signature in the query; your vault functions know how to verify it.
    const host = event.headers["x-forwarded-host"] || event.headers.host;
    const scheme = event.headers["x-forwarded-proto"] || "https";
    const target = `${scheme}://${host}/.netlify/functions/${fnName}${qs.size ? `?${qs}` : ""}`;

    const method = event.httpMethod || "GET";
    const needsBody = ["POST", "PUT", "PATCH"].includes(method);
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : (event.body || "");

    const resp = await fetch(target, {
      method,
      headers: {
        "Content-Type":
          event.headers?.["content-type"] ||
          event.headers?.["Content-Type"] ||
          "application/json",
      },
      body: needsBody ? rawBody : undefined,
    });

    const text = await resp.text();
    return {
      statusCode: resp.status,
      headers: {
        "Content-Type": resp.headers.get("content-type") || "application/json",
        // match your vault functions' permissive CORS so the shop UI is happy
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Content-Type",
      },
      body: text,
    };
  };

  if (suffix === "/v3/vault/list")   return await forwardToFunction("vault-list");
  if (suffix === "/v3/vault/add")    return await forwardToFunction("vault-add");
  if (suffix === "/v3/vault/update") return await forwardToFunction("vault-update");
  /* ──────────────────────────────────────────────────────────── */

  // 2) everything else → forward to n8n
  const base = (process.env.N8N_ENGINE_BASE_URL || process.env.N8N_ENGINE_WEBHOOK_URL || "").replace(/\/$/, "");
  if (!base) return json(500, { error: "missing N8N_ENGINE_BASE_URL" });

  const qs = new URLSearchParams(url.searchParams);
  qs.delete("signature");
  const path = suffix === "/" ? "/run" : suffix;
  const target = `${base}${path}${qs.toString() ? `?${qs}` : ""}`;

  const method = event.httpMethod || "GET";
  const needsBody = ["POST", "PUT", "PATCH"].includes(method);
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");

  const resp = await fetch(target, {
    method,
    headers: {
      "Content-Type":
        event.headers?.["content-type"] ||
        event.headers?.["Content-Type"] ||
        "application/json",
      "X-Channel": "shopify-proxy",
      "X-Shop": url.searchParams.get("shop") || "",
      "X-Logged-In-Customer-Id": url.searchParams.get("logged_in_customer_id") || "",
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
