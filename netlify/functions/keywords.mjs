// netlify/functions/keywords.mjs
// If your Netlify runtime is Node 18+, you can remove node-fetch and use global fetch.
import fetch from "node-fetch";
import crypto from "crypto";

const D4S_BASE = "https://api.dataforseo.com/v3";
const D4S_USER = process.env.D4S_USER;      // set in Netlify env
const D4S_PASS = process.env.D4S_PASS;      // set in Netlify env
const SHOPIFY_APP_PROXY_SECRET = process.env.SHOPIFY_APP_PROXY_SECRET || ""; // optional

// Minimal market → location_code map (expand as you need)
const LOC = { US: 2840, NZ: 2276, AU: 2036, KR: 2372, SG: 2708, HK: 2141, JP: 2392 };

// ----- Helpers -----
const authHeader = "Basic " + Buffer.from(`${D4S_USER}:${D4S_PASS}`).toString("base64");

function verifyProxySignature(rawQuery, secret) {
  if (!secret) return true; // skip if not configured
  const params = new URLSearchParams(typeof rawQuery === "string" ? rawQuery : "");
  const hmac = params.get("hmac");
  const signature = params.get("signature");
  if (!hmac && !signature) return false;

  // remove signature params before computing digest
  ["hmac", "signature"].forEach(k => params.delete(k));
  const message = params.toString(); // URLSearchParams is already sorted

  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  // timingSafeEqual only when both exist; fallback for legacy 'signature'
  if (hmac) {
    try { return crypto.timingSafeEqual(Buffer.from(hmac, "utf8"), Buffer.from(digest, "utf8")); }
    catch { return false; }
  }
  if (signature) return signature === digest;
  return false;
}

// Normalizer to the shape your UI uses
function normItem({
  keyword, query, question,
  search_volume, avg_search_volume,
  keyword_difficulty, competition, cpc,
  monthly_searches, trend, intent
}) {
  const series = Array.isArray(monthly_searches)
    ? monthly_searches.map(m => Number(m.search_volume || m.value || 0))
    : Array.isArray(trend) ? trend : [];

  const t0 = series.length ? series[0] : 0;
  const tN = series.length ? series[series.length - 1] : 0;
  const trend_90d = (t0 > 0) ? (tN - t0) / t0 : 0;

  const kd =
    keyword_difficulty === undefined || keyword_difficulty === null
      ? null
      : Number(keyword_difficulty);

  return {
    keyword: keyword || query || question || "",
    volume: Number(search_volume ?? avg_search_volume ?? 0),
    kd,
    trend_90d,
    trend_series: series,
    is_question: !!question || (typeof intent === "string" && intent.includes("question"))
  };
}

// Extract items from DataForSEO response shapes
function extractItems(d4sJson) {
  const out = [];
  const tasks = d4sJson?.tasks || [];
  for (const t of tasks) {
    for (const r of (t.result || [])) {
      for (const it of (r.items || [])) out.push(it);
    }
  }
  return out;
}

async function d4sPOST(path, body) {
  const res = await fetch(`${D4S_BASE}/${path}`, {
    method: "POST",
    headers: {
      "Authorization": authHeader,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DataForSEO ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ----- Handler -----
export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Only POST", items: [] }) };
    }

    // OPTIONAL: verify Shopify App Proxy (recommended in production)
    // if (!verifyProxySignature(event.rawQuery || event.queryStringParameters, SHOPIFY_APP_PROXY_SECRET)) {
    //   return { statusCode: 403, headers: { "Content-Type":"application/json" }, body: JSON.stringify({ error: "Bad signature", items: [] }) };
    // }

    // Safer body parse
    let req = {};
    try { req = JSON.parse(event.body || "{}"); } catch {}

    const {
      mode = "search",
      seed = "",
      url = "",
      market = "US",
      language = "en",
      max = 30,
      use_ai = false // accepted for future AI Keyword Data merge (ignored for now)
    } = req;

    const location_code = LOC[String(market).toUpperCase()] || 2840;
    const language_code = String(language).toLowerCase();

    let path = "";
    let body = {};

    if (mode === "search") {
      // Google Ads: keywords for keywords (Live)
      path = "keywords_data/google_ads/keywords_for_keywords/live";
      body = {
        keywords: [seed],
        language_code,
        location_code,
        include_clickstream_data: true,
        limit: Math.min(Number(max) || 30, 60)
      };
    } else if (mode === "buyer") {
      // Google Ads: keywords for site (Live) — seed by URL
      path = "keywords_data/google_ads/keywords_for_site/live";
      body = {
        target: url,
        language_code,
        location_code,
        include_clickstream_data: true,
        limit: Math.min(Number(max) || 20, 60)
      };
    } else if (mode === "questions") {
      // Labs: questions (Live)
      path = "dataforseo_labs/google/questions/live";
      body = {
        keyword: seed,
        language_code,
        location_code,
        limit: Math.min(Number(max) || 20, 60)
      };
    } else if (mode === "ai_overview") {
      // Labs: related keywords (Live) as initial "overview" signals
      // (When ready, use `use_ai` to also merge AI Keyword Data task results here)
      path = "dataforseo_labs/google/related_keywords/live";
      body = {
        keyword: seed,
        language_code,
        location_code,
        limit: Math.min(Number(max) || 10, 60)
      };
    } else {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Unknown mode", items: [] })
      };
    }

    const d4s = await d4sPOST(path, body);
    const raw = extractItems(d4s);
    const items = raw.map(normItem).filter(r => r.keyword);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: String(err.message || err), items: [] })
    };
  }
}
