// netlify/functions/_lib/_ops.mjs
import { errlog } from './_errlog.mjs';
import { json, CORS, sb } from './_supabase.mjs';

// Case-insensitive header read
export const hget = (req, name) =>
  (req.headers?.get?.(name) ??
   req.headers?.get?.(name.toLowerCase()) ??
   req.headers?.get?.(name.toUpperCase())) || "";

// Extract shop from query or common headers
export function getShop(req) {
  try {
    const u = new URL(req.url);
    return (u.searchParams.get('shop') ||
            hget(req,'x-shop') ||
            hget(req,'x-shopify-shop-domain') || "")
      .toLowerCase();
  } catch { return ""; }
}

// Correlation id (propagate or mint)
export function getRequestId(req) {
  return hget(req, 'x-request-id') || hget(req, 'cf-ray') ||
         Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Standardized error codes (short taxonomy)
export const E = {
  BAD_INPUT: 'E_BAD_INPUT',
  TIMEOUT: 'E_TIMEOUT',
  DOWNSTREAM_5XX: 'E_DOWNSTREAM_5XX',
  BAD_SIGNATURE: 'E_BAD_SIGNATURE',
  EXCEPTION: 'E_EXCEPTION',
};

// Wrap a handler: OPTIONS, try/catch, error logging
export function withSafe(route, handler) {
  return async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const shop = getShop(req);
    const request_id = getRequestId(req);
    try {
      const res = await handler(req, { shop, request_id });
      return res;
    } catch (e) {
      await errlog({
        shop, route, status: 500,
        message: `${route} exception`,
        detail: String(e),
        request_id,
        code: E.EXCEPTION,
      });
      return json({ error: 'internal', request_id }, 500);
    }
  };
}

// Fetch that logs non-OKs/exceptions
export async function safeFetch({ route, shop, request_id }, input, init = {}) {
  try {
    const resp = await fetch(input, init);
    if (!resp.ok) {
      const detail = await resp.clone().text();
      await errlog({
        shop, route, status: resp.status,
        message: `downstream failed`,
        detail, request_id,
        code: resp.status >= 500 ? E.DOWNSTREAM_5XX : undefined,
      });
    }
    return resp;
  } catch (e) {
    await errlog({
      shop, route, status: 500,
      message: `downstream exception`,
      detail: String(e), request_id, code: E.EXCEPTION,
    });
    throw e;
  }
}

// Feature flags (service_config), with 30s in-memory cache
const flagCache = { t: 0, map: new Map() };
export async function getFlag(key, fallback=false) {
  const now = Date.now();
  if (now - flagCache.t > 30_000) {
    try {
      const { data, error } = await sb().from('service_config').select('key,value');
      if (!error && Array.isArray(data)) {
        flagCache.map = new Map(data.map(r => [r.key, r.value]));
        flagCache.t = now;
      }
    } catch {}
  }
  const v = flagCache.map.get(key);
  return (typeof v?.value !== 'undefined') ? v.value : (typeof v !== 'undefined' ? v : fallback);
}
