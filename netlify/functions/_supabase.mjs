import { createClient } from '@supabase/supabase-js';

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type, x-seoboss-version'
};

export function sb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, { auth: { persistSession: false } });
}

export function json(res, status = 200, headers = {}) {
  return new Response(JSON.stringify(res), {
    status,
    headers: { 'content-type': 'application/json', ...CORS, ...headers },
  });
}
