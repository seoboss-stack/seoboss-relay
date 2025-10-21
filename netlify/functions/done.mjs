// netlify/functions/done.mjs
import { sb, json, CORS } from './_lib/_supabase.mjs';
import { errlog } from './_lib/_errlog.mjs';  // ✅ ADD THIS

function isAuthorized(req, body) {
  const u = new URL(req.url);
  const expected = String(process.env.FORWARD_SECRET || '');
  if (!expected) return false;
  const tokenQs  = u.searchParams.get('token') || '';
  const tokenHdr = req.headers.get('x-seoboss-forward-secret') || req.headers.get('X-SEOBOSS-FORWARD-SECRET') || '';
  const authHdr  = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  const bearer   = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const tokenBody = body && (body.token || body.secret || body.forward_secret) || '';
  return [tokenQs, tokenHdr, bearer, tokenBody].some(v => v && v === expected);
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST')   return json({ error: 'POST only' }, 405);

  // ✅ ADD THIS - Extract request_id (may not exist from n8n, that's OK)
  const request_id = req.headers.get('x-request-id') || req.headers.get('X-Request-Id') || '';

  let body = {};
  try { body = await req.json(); } catch {}

  try {
    if (!isAuthorized(req, body)) return json({ error: 'Unauthorized' }, 401);

    const jobId  = body?.jobId || body?.__async?.jobId;
    const status = body?.status || 'done';
    const result = body?.result ?? null;
    const errStr = (body?.error_text || body?.error) ? String(body.error_text || body.error) : null;
    const shop   = (body?.shop || req.headers.get('x-shop') || '').toLowerCase() || null;

    if (!jobId) return json({ error: 'Missing jobId' }, 400);

    const supa = sb();
    const update = {
      status: errStr ? 'error' : status,
      updated_at: new Date().toISOString(),
    };
    if (result !== undefined) update.result_json = result;
    if (errStr) update.error_text = errStr;

    let q = supa.from('jobs').update(update).eq('job_id', jobId);
    if (shop) q = q.eq('shop', shop);

    const { error: dbErr } = await q;

    // ✅ ADD THIS - Log DB update failure
    if (dbErr) {
      await errlog({
        shop: shop || '',
        route: '/done',
        status: 500,
        message: 'Failed to update job status',
        detail: `jobId: ${jobId}, dbError: ${dbErr.message}`,
        request_id,
        code: 'E_DB_WRITE'
      });
      return json({ error: 'db update failed', detail: dbErr.message }, 500);
    }

    return json({ ok: true, jobId, shop, status: update.status }, 200);

  } catch (e) {
    // ✅ ADD THIS - Log uncaught exceptions
    await errlog({
      shop: body?.shop || '',
      route: '/done',
      status: 500,
      message: 'Uncaught exception in done endpoint',
      detail: e.stack || String(e),
      request_id,
      code: 'E_EXCEPTION'
    });
    return json({ error: 'internal', detail: String(e) }, 500);
  }
};
