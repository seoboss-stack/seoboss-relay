// netlify/functions/usage-mark.mjs
import crypto from 'node:crypto';
import { sb, json, CORS } from './_lib/_supabase.mjs';
import { errlog } from './_lib/_errlog.mjs';  // ✅ ADD THIS

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'POST only' }, 405);

  // ✅ ADD THIS - Extract request_id
  const request_id = req.headers.get('x-request-id') || '';

  try {
    const u = new URL(req.url);
    const token = u.searchParams.get('token') || req.headers.get('x-seoboss-forward-secret') || '';
    if (token !== (process.env.FORWARD_SECRET || '')) return json({ error: 'Unauthorized' }, 401);

    let body = {};
    try {
      body = await req.json();
    } catch (e) {
      body = {};
    }

    const shop   = String(body.shop || '').toLowerCase().trim();
    const action = String(body.action || '').toLowerCase().trim();   // e.g. keyword_basic | keyword_ai
    const units  = Number.isFinite(+body.cost_units) ? +body.cost_units : 1;

    if (!shop || !action) return json({ error: 'Missing shop or action' }, 400);

    const supa = sb();

    const { error } = await supa.from('jobs').insert({
      job_id: crypto.randomUUID(),
      shop,
      action,
      cost_units: units,
      status: 'done',                                // keywords: synchronous
      result_json: null,                             // optional small metadata
      ttl_at: new Date(Date.now() + 30*24*60*60*1000).toISOString()
    });

    // ✅ ADD THIS - Log DB insert failure
    if (error) {
      await errlog({
        shop,
        route: '/usage-mark',
        status: 500,
        message: 'Failed to mark usage in jobs table',
        detail: `action: ${action}, units: ${units}, error: ${error.message}`,
        request_id,
        code: 'E_DB_WRITE'
      });
      return json({ error: 'db_insert_failed', detail: error.message }, 500);
    }

    return json({ ok: true }, 200);

  } catch (e) {
    // ✅ ADD THIS - Log uncaught exceptions
    let body = {};
    try { body = await req.json(); } catch {}

    await errlog({
      shop: body.shop || '',
      route: '/usage-mark',
      status: 500,
      message: 'Uncaught exception in usage-mark',
      detail: e.stack || String(e),
      request_id,
      code: 'E_EXCEPTION'
    });

    return json({ error: 'internal', detail: String(e) }, 500);
  }
};
