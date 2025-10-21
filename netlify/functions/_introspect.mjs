// netlify/functions/_introspect.mjs
import { json, CORS, sb } from './_lib/_supabase.mjs';

// Track when this function was deployed/restarted
const BOOT_TIME = Date.now();

async function ping(url, { method='GET', headers={}, timeoutMs=2500 } = {}) {
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
  const uptimeSeconds = Math.floor((Date.now() - BOOT_TIME) / 1000);

  const base = {
    service: 'seoboss-relay',
    version: process.env.RELAY_VERSION || 'v3.2.1',
    time: nowIso,
    uptime_seconds: uptimeSeconds,
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

  // Always check health endpoints (public data)
  const [proxyHealth, vaultHealth] = await Promise.all([
    ping(`${origin}/proxy/_alive`),
    ping(`${origin}/.netlify/functions/vault-alive`),
  ]);

  const body = {
    ...base,
    health: {
      proxy: { url: '/proxy/_alive', ...proxyHealth },
      vault: { url: '/.netlify/functions/vault-alive', ...vaultHealth },
    },
  };

  // Admin-only: Show operational data
  if (admin) {
    try {
      const supa = sb();
      const since = new Date(Date.now() - 60*60*1000).toISOString();

      // Get error count (last hour)
      const { count: errors_last_hour } = await supa
        .from('function_errors')
        .select('id', { count: 'exact', head: true })
        .gte('ts', since);

      // Get last 5 errors with details
      const { data: recent_errors } = await supa
        .from('function_errors')
        .select('ts, shop, route, status, message, request_id')
        .order('ts', { ascending: false })
        .limit(5);

      // Check if correlation IDs are flowing through
      const { data: recent_requests } = await supa
        .from('function_errors')
        .select('request_id')
        .not('request_id', 'is', null)
        .order('ts', { ascending: false })
        .limit(10);

      const correlation_ids_working = recent_requests?.length > 0;

      // Optional: Test billing endpoint for specific shop
      const u = new URL(req.url);
      const shop = (u.searchParams.get('shop') || '').toLowerCase();
      let billing_probe = null;
      if (shop) {
        billing_probe = await ping(`${origin}/.netlify/functions/billing-status?shop=${encodeURIComponent(shop)}`);
      }

      body.ops = {
        errors_last_hour: errors_last_hour ?? 0,
        recent_errors: recent_errors || [],
        correlation_health: {
          working: correlation_ids_working,
          sample_ids: recent_requests?.slice(0, 3).map(r => r.request_id) || [],
          total_tracked: recent_requests?.length || 0
        },
        billing_probe,
        node: {
          pid: process.pid,
          v: process.versions,
          rss_mb: Math.round(process.memoryUsage().rss/1024/1024),
        },
      };
    } catch (e) {
      body.ops_error = String(e?.message || e);
    }
  }

  return json(body, 200);
};
