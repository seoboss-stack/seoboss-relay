// /netlify/functions/start.mjs
import { sb, json, CORS } from './_supabase.mjs';
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
    if (!n8nUrl) return json({ error: 'Missing N8N_JOB_WEBHOOK_URL' }, 500);

    const u = new URL(req.url);
    u.pathname = '/.netlify/functions/done';
    const callback = `${u.toString()}?token=${encodeURIComponent(process.env.FORWARD_SECRET || '')}`;

    // ---- debug logging WITHOUT changing the API response ----
    console.log('[start]', jobId, '→', n8nUrl, 'cb:', callback);

    fetch(n8nUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, input: body, callback_url: callback })
    })
      .then(async (resp) => {
        const text = await resp.text();
        console.log('[start] n8n responded', jobId, resp.status, text.slice(0, 120));
      })
      .catch((e) => {
        console.error('[start] n8n fetch error', jobId, e);
      });

    // return immediately (unchanged)
    return json({ ok: true, jobId });
  } catch (e) {
    console.error('START error:', e);
    return json({ error: 'internal', detail: String(e) }, 500);
  }
};
