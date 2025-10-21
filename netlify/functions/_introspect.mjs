// netlify/functions/_introspect.mjs
import { json } from './_lib/_supabase.mjs';

function isAdmin(req) {
  const hdr = req.headers.get('x-seoboss-forward-secret') || '';
  const sec = process.env.FORWARD_SECRET || '';
  return !!sec && hdr === sec;
}

export default async (req) => {
  const pubOnly = !isAdmin(req); // public if header not present / mismatch

  const body = {
    service: 'seoboss-relay',
    version: process.env.RELAY_VERSION || 'v3.2.1',
    time: new Date().toISOString(),
    routes: [
      '/v3/billing/status','/v3/billing/allow','/v3/usage/mark',
      '/v3/vault/list','/v3/vault/add','/v3/vault/update','/v3/vault/delete',
      '/proxy/_alive','/v3/vault/_alive'
    ],
    env: {
      supabase: !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_KEY,
      forward_secret: !!process.env.FORWARD_SECRET,
      n8n_engine_base: !!process.env.N8N_ENGINE_BASE_URL,
    }
  };

  if (!pubOnly) {
    // admin-only extras (still non-sensitive; no secrets echoed)
    body.node = {
      versions: process.versions,
      pid: process.pid,
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024)
    };
    body.flags = {
      // room for future feature flags read from DB if you add them
    };
  }

  return json(body, 200);
};
