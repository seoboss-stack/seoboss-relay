// netlify/functions/done.mjs
import { sb, json, CORS } from './_lib/_supabase.mjs';

function isAuthorized(req) {
  const u = new URL(req.url);
  const expected = String(process.env.FORWARD_SECRET || '');

  // Accept either ?token=... OR header X-SEOBOSS-FORWARD-SECRET
  const tokenQs  = u.searchParams.get('token') || '';
  const tokenHdr = req.headers.get('x-seoboss-forward-secret')
                || req.headers.get('X-SEOBOSS-FORWARD-SECRET')
                || '';

  return expected && (tokenQs === expected || tokenHdr === expected);
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST')   return json({ error: 'POST only' }, 405);

  try {
    if (!isAuthorized(req)) return json({ error: 'Unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));

    // Accept multiple shapes from n8n
    const jobId  = body?.jobId || body?.__async?.jobId;
    const status = body?.status || 'done';
    const result = body?.result ?? null;
    const errStr = (body?.error_text || body?.error) ? String(body.error_text || body.error) : null;

    // Prefer explicit shop; fallback to header if passed along
    const shop = (body?.shop || req.headers.get('x-shop') || '').toLowerCase() || null;

    if (!jobId) return json({ error: 'Missing jobId' }, 400);

    const supa = sb();

    // Build update
    const update = {
      status: errStr ? 'error' : status,
      updated_at: new Date().toISOString(),
    };
    if (result !== undefined) update.result_json = result;
    if (errStr) update.error_text = errStr;

    // Scope by shop when provided (safer for multi-tenant)
    let q = supa.from('jobs').update(update).eq('job_id', jobId);
    if (shop) q = q.eq('shop', shop);

    const { error: dbErr } = await q;
    if (dbErr) return json({ error: 'db update failed', detail: dbErr.message }, 500);

    // Friendly JSON response (UI polling doesn’t care, but helpful for logs)
    return json({ ok: true, jobId, shop, status: update.status }, 200);
  } catch (e) {
    console.error('DONE error:', e);
    return json({ error: 'internal', detail: String(e) }, 500);
  }
};
