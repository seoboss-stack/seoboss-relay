// netlify/functions/usage-mark.mjs
import crypto from 'node:crypto';
import { sb, json, CORS } from './_lib/_supabase.mjs';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'POST only' }, 405);

  try {
    // server-to-server auth from n8n
    const token = (new URL(req.url)).searchParams.get('token') || '';
    if (token !== (process.env.FORWARD_SECRET || '')) return json({ error: 'Unauthorized' }, 401);

    const body   = await req.json().catch(() => ({}));
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
      status: 'done',                 // keywords are synchronous
      result_json: null,              // optional: attach small metadata if you want
      ttl_at: new Date(Date.now() + 30*24*60*60*1000).toISOString()
    });
    if (error) return json({ error: 'db_insert_failed', detail: error.message }, 500);

    return json({ ok: true }, 200);
  } catch (e) {
    return json({ error: 'internal', detail: String(e) }, 500);
  }
};
