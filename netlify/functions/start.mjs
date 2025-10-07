// netlify/functions/start.mjs
import { sb, json, CORS } from './_lib/_supabase.mjs';
import { randomUUID } from 'node:crypto';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    // whatever your UI sent (the same fields your old flow expects)
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

    // tenant (prefer from input; fallback to env/dev)
    const shop = String(
      input.shop || input.shopDomain || process.env.SHOP_DOMAIN || 'seoboss-engine.myshopify.com'
    ).toLowerCase().trim();

    // mimic old channel for max compatibility
    const channel = 'shopify-proxy';

    // callback URL back to /done
    const u = new URL(req.url);
    u.pathname = '/.netlify/functions/done';
    const callback = `${u.toString()}?token=${encodeURIComponent(secret)}`;

    // === HEADERS (validator reads these from $json.headers) ===
    const headers = {
      'content-type': 'application/json',
      'x-seoboss-forward-secret': secret,
      'x-seoboss-ts': ts,
      'x-shop': shop,
      'x-channel': channel,
    };

    // === BODY (make it look like v3): flatten article inputs at $json.body ===
    // Carry async metadata under a namespaced key the old flow will ignore.
    const body = {
      ...input,                 // <-- your title, tags, blog_id, etc. right here
      __async: {
        jobId,
        callback_url: callback, // use this later for the final callback
      },
    };

    // POST to n8n
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

    // respond to the browser (UI will poll /result)
    return json({
      ok: true,
      jobId,
      debug: { n8nUrl, n8nStatus, n8nText, n8nErr, callback, shop, ts, channel }
    });
  } catch (e) {
    return json({ error: 'internal', detail: String(e) }, 500);
  }
};
