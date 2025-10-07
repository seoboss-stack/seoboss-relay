// netlify/functions/start.mjs
import { sb, json, CORS } from './_lib/_supabase.mjs';
import { randomUUID } from 'node:crypto';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    const input = await req.json().catch(() => ({}));
    const jobId = randomUUID();

    const supa = sb();
    const { error } = await supa.from('jobs').insert({ job_id: jobId, status: 'queued' });
    if (error) return json({ error: 'db insert failed', detail: error.message }, 500);

    const n8nUrl = process.env.N8N_JOB_WEBHOOK_URL;
    if (!n8nUrl) return json({ error: 'Missing N8N_JOB_WEBHOOK_URL' }, 500);

    const secret = String(process.env.FORWARD_SECRET || '');
    const ts = Math.floor(Date.now() / 1000).toString();
    const shop = process.env.SHOP_DOMAIN || 'seoboss-engine.myshopify.com';
    const channel = 'relay';

    const u = new URL(req.url);
    u.pathname = '/.netlify/functions/done';
    const callback = `${u.toString()}?token=${encodeURIComponent(secret)}`;

    // Shape exactly as your n8n validator expects:
    const envelope = {
      headers: {
        'x-seoboss-forward-secret': secret,
        'x-seoboss-ts': ts,
        'x-shop': shop,
        'x-channel': channel,
      },
      body: {
        jobId,
        input,
        callback_url: callback,
      },
    };

    // Call n8n (keep small debug so we can see status if needed)
    let n8nStatus = null, n8nText = null, n8nErr = null;
    try {
      const resp = await fetch(n8nUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      });
      n8nStatus = resp.status;
      n8nText = (await resp.text()).slice(0, 160);
    } catch (e) {
      n8nErr = String(e);
    }

    return json({ ok: true, jobId, debug: { n8nUrl, n8nStatus, n8nText, n8nErr, callback, shop, ts } });
  } catch (e) {
    return json({ error: 'internal', detail: String(e) }, 500);
  }
};
