import { createClient } from '@supabase/supabase-js';

export function sb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, { auth: { persistSession: false } });
}

export function json(res, status = 200, headers = {}) {
  return new Response(JSON.stringify(res), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
