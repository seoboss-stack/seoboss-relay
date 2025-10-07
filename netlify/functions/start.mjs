// netlify/functions/start.mjs
import { sb, json, CORS } from '../shared/_supabase.mjs';
import { randomUUID } from 'node:crypto';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const jobId = randomUUID();

    const supa = sb();
    const { error } = await supa.from('jobs').insert({ job_id: jobId, status: 'queued' });
    if (error) return json({ error: 'db insert failed', detail: error.message }, 500);

    const n8nUrl = process.env.N8N_JOB_WEBHOOK_URL;
    const secret = process.env.FORWARD_SECRET || '';
    if (!n8nUrl) return json({ error: 'Missing N8N_JOB_WEBHOOK_URL' }, 500);

    const u = new URL(req.url);
    u.pathname = '/.netlify/functions/done';
    const callback = `${u.toString()}?token=${encodeURIComponent(secret)}`;

    // one-time inline debug so we can see webhook status from the response
    let n8nStatus = null, n8nText = null, n8nErr = null;
    try {
      const resp = await fetch(n8nUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId, input: body, callback_url: callback }),
      });
      n8nStatus = resp.status;
      n8nText = (await resp.text()).slice(0, 160);
    } catch (e) {
      n8nErr = String(e);
    }

    return json({
      ok: true,
      jobId,
      debug: { n8nUrl, n8nStatus, n8nText, n8nErr, callback },
    });
  } catch (e) {
    return json({ error: 'internal', detail: String(e) }, 500);
  }
};
