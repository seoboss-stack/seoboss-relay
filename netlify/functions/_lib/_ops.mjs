// netlify/functions/_lib/_ops.mjs
import { errlog } from './_errlog.mjs';
import { json, CORS } from './_supabase.mjs';

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
        detail: String(e), request_id
      });
      return json({ error: 'internal', request_id }, 500);
    }
  };
}

// Fetch that auto-logs non-OKs/exceptions
export async function safeFetch({ route, shop, request_id }, input, init = {}) {
  try {
    const resp = await fetch(input, init);
    if (!resp.ok) {
      const detail = await resp.clone().text();
      await errlog({
        shop, route, status: resp.status,
        message: `downstream failed`,
        detail, request_id
      });
    }
    return resp;
  } catch (e) {
    await errlog({
      shop, route, status: 500,
      message: `downstream exception`,
      detail: String(e), request_id
    });
    throw e;
  }
}
