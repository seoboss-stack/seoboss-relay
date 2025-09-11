// netlify/functions/log.mjs
import { createClient } from '@supabase/supabase-js';

const supa = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// never throw from the logger
export async function logFnError({
  fn, shop, client_id, message, status, request_id, detail, stack
}) {
  try {
    await supa.from('function_errors').insert({
      fn,
      shop: shop ?? null,
      client_id: client_id ?? null,
      message: String(message).slice(0, 8000),
      http_status: status ?? null,
      request_id: request_id ?? null,
      detail: detail ?? null,
      stack: stack ? String(stack).slice(0, 8000) : null,
      level: 'error'
    });
  } catch {}
}
