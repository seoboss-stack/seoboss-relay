// netlify/functions/start.mjs
import { sb, json, CORS } from './_lib/_supabase.mjs';
import { randomUUID } from 'node:crypto';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    const input = await req.json().catch(() => ({}));
    const jobId = randomUUID();

    // --- Resolve tenant (prefer App Proxy) ---
    const url = new URL(req.url);
    const proxyShop = url.searchParams.get('shop') || req.headers.get('x-shopify-shop-domain');
    const shop = String(
      proxyShop || input.shop || input.shopDomain || process.env.SHOP_DOMAIN || 'seoboss-engine.myshopify.com'
    ).toLowerCase().trim();

    // --- Create job row (scoped) ---
    const supa = sb();
    {
      const { error } = await supa.from('jobs').insert({
        job_id: jobId,
        shop,
        client_id: input.client_id || null,
        sheet_id: input.sheet_id || null,
        status: 'queued',
      });
      if (error) return json({ error: 'db insert failed', detail: error.message }, 500);
    }

    // --- Env / headers for n8n call ---
    const n8nUrl = process.env.N8N_JOB_WEBHOOK_URL;
    if (!n8nUrl) return json({ error: 'Missing N8N_JOB_WEBHOOK_URL' }, 500);

    const secret = String(process.env.FORWARD_SECRET || '');
    const ts = Math.floor(Date.now() / 1000).toString();
    const channel = 'shopify-proxy';

    // Callback back to our /done function
    const u = new URL(req.url);
    u.pathname = '/.netlify/functions/done';
    const callback = `${u.toString()}?token=${encodeURIComponent(secret)}`;

    const headers = {
      'content-type': 'application/json',
      'x-seoboss-forward-secret': secret,
      'x-seoboss-ts': ts,
      'x-shop': shop,
      'x-channel': channel,
    };

    // --- Forward full context to n8n ---
    const body = {
      ...input,        // your title/meta/blog_id/etc + client_id + sheet_id
      shop,
      __async: { jobId, callback_url: callback },
    };

    let n8nStatus = null, n8nText = null, n8nErr = null;
    try {
      const resp = await fetch(n8nUrl, { method: 'POST', headers, body: JSON.stringify(body) });
      n8nStatus = resp.status;
      n8nText = (await resp.text()).slice(0, 200);
    } catch (e) {
      n8nErr = String(e);
    }

    return json({
      ok: true,
      jobId,
      debug: { n8nUrl, n8nStatus, n8nText, n8nErr, callback, shop, ts, channel }
    });
  } catch (e) {
    return json({ error: 'internal', detail: String(e) }, 500);
  }
};
