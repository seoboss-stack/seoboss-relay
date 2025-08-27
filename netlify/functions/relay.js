{\rtf1\ansi\ansicpg1252\cocoartf2822
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\paperw11900\paperh16840\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 // netlify/functions/relay.js (CommonJS secure relay)\
const crypto = require("crypto");\
\
const ALLOW_ORIGINS = new Set([\
  "https://seoboss.com",\
  // "http://localhost:3000", // enable for local dev if needed\
]);\
\
const ROUTE_MAP = \{\
  // Engine\
  "/seoboss/api/hints":                "N8N_HINTS_URL",\
  "/seoboss/api/blog-titles":          "N8N_TITLES_URL",\
  "/seoboss/api/blog-post":            "N8N_POST_URL",\
  "/seoboss/api/trending-questions":   "N8N_TRENDING_QS_URL",\
  "/seoboss/api/trending-searches":    "N8N_TRENDING_SEARCHES_URL",\
  "/seoboss/api/vault-add":            "N8N_VAULT_ADD_URL",\
  "/seoboss/api/vault-load":           "N8N_VAULT_LOAD_URL",\
\
  // Onboarding\
  "/seoboss/api/onboarding/submit":    "N8N_ONBOARD_SUBMIT_URL",\
  "/seoboss/api/onboarding/activate":  "N8N_ONBOARD_ACTIVATE_URL",\
  "/seoboss/api/onboarding/resend":    "N8N_ONBOARD_RESEND_URL",\
  "/seoboss/api/client/profile":       "N8N_CLIENT_PROFILE_URL",\
  "/seoboss/api/shop/blogs":           "N8N_SHOP_LIST_BLOGS_URL",\
  "/seoboss/api/shop/import-articles": "N8N_SHOP_IMPORT_URL",\
\
  // Provider (Shopify webhooks etc.)\
  "/seoboss/api/shopify":              "N8N_SHOPIFY_URL",\
\};\
\
function isProviderRoute(p) \{ return p === "/seoboss/api/shopify"; \}\
\
function timingSafeEq(a, b) \{\
  const A = Buffer.from(a, "hex");\
  const B = Buffer.from(b, "hex");\
  return A.length === B.length && crypto.timingSafeEqual(A, B);\
\}\
\
exports.handler = async (event) => \{\
  // CORS preflight\
  if (event.httpMethod === "OPTIONS") \{\
    const anyOrigin = Array.from(ALLOW_ORIGINS)[0] || "*";\
    return \{\
      statusCode: 204,\
      headers: \{\
        "Access-Control-Allow-Origin": anyOrigin,\
        "Access-Control-Allow-Methods": "POST, OPTIONS",\
        "Access-Control-Allow-Headers": "Content-Type, X-Seoboss-Ts, X-Seoboss-Hmac, X-Seoboss-Key-Id",\
      \},\
    \};\
  \}\
\
  if (event.httpMethod !== "POST") \{\
    return \{ statusCode: 405, body: "Method not allowed" \};\
  \}\
\
  // Strip /.netlify/functions/relay prefix if present\
  let path = event.path || "";\
  path = path.replace("/.netlify/functions/relay", "");\
\
  const envKey = ROUTE_MAP[path];\
  const upstream = envKey ? process.env[envKey] : null;\
  if (!upstream) \{\
    return \{ statusCode: 404, body: JSON.stringify(\{ ok:false, error:"Unknown route", path \}) \};\
  \}\
\
  const isProvider = isProviderRoute(path);\
  const origin = event.headers.origin || "";\
\
  // Enforce origin (skip for provider webhooks like Shopify)\
  if (!isProvider && !ALLOW_ORIGINS.has(origin)) \{\
    return \{ statusCode: 403, body: JSON.stringify(\{ ok:false, error:"Forbidden origin" \}) \};\
  \}\
\
  // Verify HMAC: body + "\\n" + ts, signed with PUBLIC_HMAC_KEY\
  if (!isProvider) \{\
    const tsHeader = event.headers["x-seoboss-ts"] || event.headers["X-Seoboss-Ts"];\
    const hmacHeader = (event.headers["x-seoboss-hmac"] || event.headers["X-Seoboss-Hmac"] || "").toLowerCase();\
\
    const ts = parseInt(tsHeader || "0", 10);\
    if (!ts || Math.abs(Date.now()/1000 - ts) > 300) \{\
      return \{ statusCode: 401, body: JSON.stringify(\{ ok:false, error:"Stale or missing timestamp" \}) \};\
    \}\
    if (!hmacHeader || !process.env.PUBLIC_HMAC_KEY) \{\
      return \{ statusCode: 401, body: JSON.stringify(\{ ok:false, error:"Missing HMAC or key" \}) \};\
    \}\
\
    const raw = event.body || "";\
    const expected = crypto\
      .createHmac("sha256", process.env.PUBLIC_HMAC_KEY)\
      .update(raw + "\\n" + ts)\
      .digest("hex");\
\
    if (!timingSafeEq(expected, hmacHeader)) \{\
      return \{ statusCode: 401, body: JSON.stringify(\{ ok:false, error:"Bad signature" \}) \};\
    \}\
  \}\
\
  // Forward to n8n\
  const resp = await fetch(upstream, \{\
    method: "POST",\
    headers: \{\
      "Content-Type": event.headers["content-type"] || "application/x-www-form-urlencoded",\
      "X-SEOBOSS-FORWARD-SECRET": process.env.FORWARD_SECRET,\
      "X-Seoboss-Ts": event.headers["x-seoboss-ts"] || event.headers["X-Seoboss-Ts"] || "",\
      "X-Seoboss-Hmac": event.headers["x-seoboss-hmac"] || event.headers["X-Seoboss-Hmac"] || "",\
      "X-Seoboss-Key-Id": event.headers["x-seoboss-key-id"] || event.headers["X-Seoboss-Key-Id"] || "",\
    \},\
    body: event.body,\
  \});\
\
  const text = await resp.text();\
  return \{\
    statusCode: resp.status,\
    headers: \{\
      "Content-Type": "application/json",\
      ...(isProvider ? \{\} : \{ "Access-Control-Allow-Origin": origin \}),\
    \},\
    body: text,\
  \};\
\};\
}