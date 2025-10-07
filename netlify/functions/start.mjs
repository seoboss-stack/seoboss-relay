// netlify/functions/start.mjs
import { sb, json, CORS } from './_lib/_supabase.mjs';
import { randomUUID } from 'node:crypto';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    // whatever your UI sent
    const input = await req.json().catch(() => ({}));
    const jobId = randomUUID();

    // create job row
    const supa = sb();
    const { error } = await supa.from('jobs').insert({ job_id: jobId, status: 'queued' });
    if (error) return json({ error: 'db insert failed', detail: error.message }, 500);

    // envs
    const n8nUrl = process.env.N8N_JOB_WEBHOOK_URL;
    if (!n8nUrl) return json({ error: 'Missing N8N_JOB_WEBHOOK_URL' }, 500);

    const secret = String(process.env.FORWARD_SECRET || '');
    const ts = Math.floor(Date.now() / 1000).toString();

    // Multi-tenant: try to take shop from the request body; fallback to env or dev store
    const shop =
      String(input.shop || input.shopDomain || process.env.SHOP_DOMAIN || 'seoboss-engine.myshopify.com')
        .toLowerCase()
        .trim();

    const channel = 'relay';

    // callback URL back to /done
    const u = new URL(req.url);
    u.pathname = '/.netlify/functions/done';
    const callback = `${u.toString()}?token=${encodeURIComponent(secret)}`;

    // --- IMPORTANT: send validator fields as REAL HTTP HEADERS ---
    const headers = {
      'content-type': 'application/json',
      'x-seoboss-forward-secret': secret, // validator checks this
      'x-seoboss-ts': ts,                 // freshness
      'x-shop': shop,                     // tenant
      'x-channel': channel,               // diagnostic/channel
    };

    // body is clean: n8n will expose it at $json.body
    const body = {
      jobId,
      input,
      callback_url: callback,
    };

    // call n8n
    let n8nStatus = null, n8nText = null, n8nErr = null;
    try {
      const resp = await fetch(n8nUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      n8nStatus = resp.status;
      n8nText = (await resp.text()).slice(0, 160);
    } catch (e) {
      n8nErr = String(e);
    }

    // respond immediately (UI will poll /result)
    return json({
      ok: true,
      jobId,
      debug: { n8nUrl, n8nStatus, n8nText, n8nErr, callback, shop, ts }
    });
  } catch (e) {
    return json({ error: 'internal', detail: String(e) }, 500);
  }
};
