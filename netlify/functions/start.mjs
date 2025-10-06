import { sb, json } from './_supabase.mjs';
import { randomUUID } from 'node:crypto';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const body = await req.json().catch(() => ({}));
  const jobId = randomUUID();

  const supa = sb();
  const { error } = await supa.from('jobs').insert({ job_id: jobId, status: 'queued' });
  if (error) return json({ error: 'db insert failed', detail: error.message }, 500);

  const n8nUrl = process.env.N8N_JOB_WEBHOOK_URL;
  const u = new URL(req.url);
  u.pathname = '/.netlify/functions/done';
  const callback = `${u.toString()}?token=${encodeURIComponent(process.env.FORWARD_SECRET)}`;

  // fire-and-forget
  fetch(n8nUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId, input: body, callback_url: callback })
  }).catch(() => {});

  return json({ ok: true, jobId });
}
