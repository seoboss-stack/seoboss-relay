// netlify/functions/_introspect.mjs
import { json, CORS } from './_lib/_supabase.mjs';
import { sb } from './_lib/_supabase.mjs';

// tiny fetch with timeout
async function ping(url, { method = 'GET', headers = {}, timeoutMs = 2500 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
  const t0 = Date.now();
  try {
    const resp = await fetch(url, { method, headers, signal: ctrl.signal });
    const ms = Date.now() - t0;
    return { ok: resp.ok, status: resp.status, ms };
  } catch (e) {
    const ms = Date.now() - t0;
    return { ok: false, status: 0, ms, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

function isAdmin(req) {
  const got = req.headers.get('x-seoboss-forward-secret') || '';
  const need = process.env.FORWARD_SECRET || '';
  return !!need && got === need;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const admin = isAdmin(req);
  const origin = `${req.headers.get('x-forwarded-proto') || 'https'}://${req.headers.get('x-forwarded-host') || req.headers.get('host')}`;
  const nowIso = new Date().toISOString();

  // Public, non-sensitive snapshot
  const base = {
    service: 'seoboss-relay',
    version: process.env.RELAY_VERSION || 'v3.2.1',
    time: nowIso,
    env: {
      supabase: !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_KEY,
      forward_secret: !!process.env.FORWARD_SECRET,
      n8n_engine_base: !!process.env.N8N_ENGINE_BASE_URL,
    },
    routes: [
      '/v3/billing/status','/v3/billing/allow','/v3/usage/mark',
      '/v3/vault/list','/v3/vault/add','/v3/vault/update','/v3/vault/delete',
      '/proxy/_alive','/.netlify/functions/vault-alive'
    ],
  };

  // Health pings (cheap, quick, no secrets returned)
  const proxyAliveUrl = `${origin}/proxy/_alive`;
  const vaultAliveUrl = `${origin}/.netlify/functions/vault-alive`;
  const [proxyHealth, vaultHealth] = await Promise.all([
    ping(proxyAliveUrl),
    ping(vaultAliveUrl),
  ]);

  const body = {
    ...base,
    health: {
      proxy: { url: '/proxy/_alive', ...proxyHealth },
      vault: { url: '/.netlify/functions/vault-alive', ...vaultHealth },
    },
  };

  // Admin-only extras (safe: no secrets echoed)
  if (admin) {
    try {
      const supa = sb();

      // recent errors (last 1h)
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count: errors_last_hour } = await supa
        .from('function_errors')
        .select('id', { count: 'exact', head: true })
        .gte('ts', since);

      // optional: quick billing sanity for a shop if provided (?shop=...)
      const u = new URL(req.url);
      const shop = (u.searchParams.get('shop') || '').toLowerCase();
      let billing_probe = null;
      if (shop) {
        // call the function directly (no App Proxy needed)
        const statusUrl = `${origin}/.netlify/functions/billing-status?shop=${encodeURIComponent(shop)}`;
        billing_probe = await ping(statusUrl);
      }

      body.ops = {
        errors_last_hour: errors_last_hour ?? 0,
        billing_probe: billing_probe, // includes ok/status/ms; only when ?shop= is passed
        node: {
          pid: process.pid,
          v: process.versions,
          rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        },
      };
    } catch (e) {
      body.ops_error = String(e?.message || e);
    }
  }

  return json(body, 200);
};
