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

    let n8nStatus = null, n8nText = null;
    try {
      // Await n8n just for this debug (it should instantly 200 because "Respond immediately")
      const resp = await fetch(n8nUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId, input: body, callback_url: callback })
      });
      n8nStatus = resp.status;
      // don't load big bodies; most n8n webhooks reply with small 'JSON'
      n8nText = (await resp.text()).slice(0, 80);
    } catch (e) {
      n8nStatus = 'fetch-error';
      n8nText = String(e);
    }

    // Return debug info so we can see exactly what URL / status the function used
    return json({
      ok: true,
      jobId,
      debug: { n8nUrl, callback, n8nStatus, n8nText }
    });
  } catch (e) {
    console.error('START error:', e);
    return json({ error: 'internal', detail: String(e) }, 500);
  }
};
