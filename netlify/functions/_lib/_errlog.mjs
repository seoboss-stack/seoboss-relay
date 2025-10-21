// netlify/functions/_lib/_errlog.mjs
import { sb } from './_supabase.mjs';

/**
 * Centralized server error logger → Supabase:function_errors
 * Safe: never throws; trims large payloads.
 */
export async function errlog({
  shop = '',
  route = '',
  status = 0,
  message = '',
  detail = '',
  client_id = '',
  level = 'error',
  request_id = '',
}) {
  try {
    const supa = sb();
    await supa.from('function_errors').insert([{
      shop,
      client_id,
      level,
      http_status: status,
      message: (message ?? '').toString().slice(0, 512),
      detail: detail ? JSON.stringify(detail).slice(0, 2000) : null,
      stack: null,
      request_id: (request_id ?? '').toString().slice(0, 128),
      // ts column uses default now()
    }]);
  } catch (e) {
    // never throw from logger
    console.error('[errlog] failed:', e?.message || e);
  }
}
