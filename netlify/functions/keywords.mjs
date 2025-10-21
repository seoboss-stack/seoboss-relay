// netlify/functions/keywords.mjs
// Uses global fetch (Node 18+). No node-fetch needed.
import crypto from "node:crypto"; // node: prefix is best practice on Netlify
import { errlog } from './_lib/_errlog.mjs';  // ✅ ADD THIS

const D4S_BASE = "https://api.dataforseo.com/v3";
const D4S_USER = process.env.D4S_USER;
const D4S_PASS = process.env.D4S_PASS;
const SHOPIFY_APP_PROXY_SECRET = process.env.SHOPIFY_APP_PROXY_SECRET || "";

const LOC = { US:2840, NZ:2276, AU:2036, KR:2372, SG:2708, HK:2141, JP:2392 };

// ----- Helpers -----
const authHeader = "Basic " + Buffer.from(`${D4S_USER}:${D4S_PASS}`).toString("base64");

function verifyProxySignature(rawQuery, secret) {
  if (!secret) return true;
  const params = new URLSearchParams(typeof rawQuery === "string" ? rawQuery : "");
  const hmac = params.get("hmac");
  const signature = params.get("signature");
  if (!hmac && !signature) return false;
  ["hmac","signature"].forEach(k => params.delete(k));
  const message = params.toString();
  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  if (hmac) {
    try { return crypto.timingSafeEqual(Buffer.from(hmac,"utf8"), Buffer.from(digest,"utf8")); }
    catch { return false; }
  }
  return signature === digest;
}

function normItem(it = {}) {
  // support both flat fields and Labs keyword_info
  const kw = it.keyword || it.query || it.question || "";
  const info = it.keyword_info || it?.keyword_data?.keyword_info || {};

  const seriesArr = it.monthly_searches || info.monthly_searches || it.trend || [];
  const series = Array.isArray(seriesArr)
    ? seriesArr.map(m => Number(m.search_volume ?? m.value ?? 0))
    : [];

  const t0 = series.length ? series[0] : 0;
  const tN = series.length ? series[series.length - 1] : 0;
  const trend_90d = t0 > 0 ? (tN - t0) / t0 : 0;

  const vol = Number(
    it.search_volume ?? it.avg_search_volume ?? info.search_volume ?? 0
  );

  let kd = it.keyword_difficulty ?? info.keyword_difficulty ?? null;
  kd = Number.isFinite(Number(kd)) ? Number(kd) : null;

  return {
    keyword: kw,
    volume: vol,
    kd,
    trend_90d,
    trend_series: series,
    is_question: !!it.question || (typeof it.intent === "string" && it.intent.includes("question")),
  };
}

function extractItems(json) {
  const out = [];
  for (const t of json?.tasks || []) {
    for (const r of t.result || []) {
      for (const it of r.items || []) out.push(it);
    }
  }
  return out;
}

async function d4sPOST(path, bodyArray) {
  const res = await fetch(`${D4S_BASE}/${path}`, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify(bodyArray), // DataForSEO expects an ARRAY of tasks
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DataForSEO ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export async function handler(event) {
  // ✅ ADD THIS - Extract request_id
  const request_id = event.headers?.["x-request-id"] || event.headers?.["X-Request-Id"] || '';
  
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Only POST", items: [] }) };
    }

    // Optional App Proxy verification
    // if (!verifyProxySignature(event.rawQuery || "", SHOPIFY_APP_PROXY_SECRET)) {
    //   return { statusCode: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Bad signature", items: [] }) };
    // }

    let req = {};
    try { req = JSON.parse(event.body || "{}"); } catch {}

    const {
      mode = "search",
      seed = "",
      url = "",
      market = "US",
      language = "en",
      max = 30,
    } = req;

    // ✅ ADD THIS - Validate DataForSEO credentials
    if (!D4S_USER || !D4S_PASS) {
      await errlog({
        shop: '',
        route: '/keywords',
        status: 500,
        message: 'DataForSEO credentials not configured',
        detail: `D4S_USER present: ${!!D4S_USER}, D4S_PASS present: ${!!D4S_PASS}`,
        request_id,
        code: 'E_CONFIG'
      }).catch(() => {});
      
      return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "API not configured", items: [] }) };
    }

    const location_code = LOC[String(market).toUpperCase()] || 2840;
    const language_code = String(language).toLowerCase();

    let path = "";
    let task = {};

    if (mode === "search") {
      path = "keywords_data/google_ads/keywords_for_keywords/live";
      task = {
        keywords: [seed],
        language_code,
        location_code,
        include_clickstream_data: true,
        limit: Math.min(Number(max) || 30, 60),
      };
    } else if (mode === "buyer") {
      path = "keywords_data/google_ads/keywords_for_site/live";
      task = {
        target: url,
        language_code,
        location_code,
        include_clickstream_data: true,
        limit: Math.min(Number(max) || 20, 60),
      };
    } else if (mode === "questions") {
      path = "dataforseo_labs/google/questions/live";
      task = {
        keyword: seed,
        language_code,
        location_code,
        limit: Math.min(Number(max) || 20, 60),
      };
    } else if (mode === "ai_overview") {
      path = "dataforseo_labs/google/related_keywords/live";
      task = {
        keyword: seed,
        language_code,
        location_code,
        limit: Math.min(Number(max) || 10, 60),
      };
    } else {
      return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unknown mode", items: [] }) };
    }

    // IMPORTANT: DataForSEO wants an ARRAY of tasks
    let d4s;
    try {
      d4s = await d4sPOST(path, [task]);
    } catch (err) {
      // ✅ ADD THIS - Log DataForSEO API failures
      await errlog({
        shop: '',
        route: '/keywords',
        status: 500,
        message: `DataForSEO API failed for mode: ${mode}`,
        detail: `seed: ${seed}, url: ${url}, error: ${err.message}`,
        request_id,
        code: 'E_DATAFORSEO_API'
      }).catch(() => {});
      
      throw err; // Re-throw to hit outer catch
    }

    const items = extractItems(d4s).map(normItem).filter(x => x.keyword);

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) };
    
  } catch (err) {
    // ✅ ADD THIS - Log uncaught exceptions
    let req = {};
    try { req = JSON.parse(event.body || "{}"); } catch {}
    
    await errlog({
      shop: '',
      route: '/keywords',
      status: 500,
      message: 'Uncaught exception in keywords endpoint',
      detail: `mode: ${req.mode}, seed: ${req.seed}, error: ${err.stack || err.message || String(err)}`,
      request_id,
      code: 'E_EXCEPTION'
    }).catch(() => {});
    
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: String(err.message || err), items: [] }) };
  }
}
