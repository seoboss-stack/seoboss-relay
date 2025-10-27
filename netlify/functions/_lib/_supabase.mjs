// netlify/functions/_lib/_supabase.mjs
import { createClient } from '@supabase/supabase-js';

// CORS headers for browser → Netlify Functions (OPTIONS + actual reqs)
export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  // allow the headers you actually send from the app
  'access-control-allow-headers': 'content-type, x-seoboss-version, x-seoboss-forward-secret, x-request-id',
  // let the client read useful response headers
  'access-control-expose-headers': 'x-request-id',
  // cache preflight for a bit
  'access-control-max-age': '600',
};

// Supabase client (service role key; no session persistence on server)
export function sb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, { auth: { persistSession: false } });
}

// JSON helper (always includes CORS + content-type)
export function json(res, status = 200, headers = {}) {
  return new Response(JSON.stringify(res), {
    status,
    headers: { 'content-type': 'application/json', ...CORS, ...headers },
  });
}
