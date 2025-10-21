// netlify/functions/_lib/_errlog.mjs
import { sb } from './_supabase.mjs';

/**
 * Centralized server error logger → Supabase:function_errors
 * Safe: never throws; trims large payloads.
 * 
 * Usage:
 *   await errlog({
 *     shop: 'test.myshopify.com',
 *     route: '/vault-list',
 *     status: 500,
 *     message: 'Timeout',
 *     detail: err.stack,
 *     request_id: 'abc12345'
 *   });
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
  code = '',  // ✅ NEW: Add error code support (E_TIMEOUT, etc.)
}) {
  try {
    const supa = sb();
    
    // ✅ FIX: Smarter detail handling
    let detailStr = null;
    if (detail) {
      if (typeof detail === 'string') {
        detailStr = detail.slice(0, 2000);
      } else {
        try {
          detailStr = JSON.stringify(detail).slice(0, 2000);
        } catch {
          detailStr = String(detail).slice(0, 2000);
        }
      }
    }
    
    await supa.from('function_errors').insert([{
      shop: (shop ?? '').toString().slice(0, 255),
      route: (route ?? '').toString().slice(0, 255),  // ✅ FIX: Was missing!
      status: status || 0,  // ✅ FIX: Match _introspect schema
      message: (message ?? '').toString().slice(0, 512),
      detail: detailStr,
      client_id: (client_id ?? '').toString().slice(0, 255),
      level: level || 'error',
      request_id: (request_id ?? '').toString().slice(0, 128),
      code: (code ?? '').toString().slice(0, 64),  // ✅ NEW: Error codes
      // ts column uses DEFAULT NOW()
    }]);
    
    return true;  // ✅ NEW: Return success for testing
  } catch (e) {
    // Never throw from logger - fail silently but log to console
    console.error('[errlog] failed:', e?.message || e);
    return false;
  }
}
