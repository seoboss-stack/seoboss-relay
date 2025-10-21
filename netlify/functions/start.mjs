// netlify/functions/start.mjs
import { sb, json, CORS } from './_lib/_supabase.mjs';
import { randomUUID } from 'node:crypto';
import { errlog } from './_lib/_errlog.mjs';  // ✅ ADD THIS

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // ✅ ADD THIS - Extract request_id early
  const request_id = req.headers.get('x-request-id') || req.headers.get('X-Request-Id') || '';

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
      
      // ✅ ADD THIS - Log DB insert failure
      if (error) {
        await errlog({
          shop,
          route: '/start',
          status: 500,
          message: 'Failed to create job in database',
          detail: `jobId: ${jobId}, error: ${error.message}`,
          request_id,
          code: 'E_DB_WRITE',
          client_id: input.client_id || null
        });
        return json({ error: 'db insert failed', detail: error.message }, 500);
      }
    }

    // --- Env / headers for n8n call ---
    const n8nUrl = process.env.N8N_JOB_WEBHOOK_URL;
    if (!n8nUrl) {
      // ✅ ADD THIS - Log missing n8n URL configuration
      await errlog({
        shop,
        route: '/start',
        status: 500,
        message: 'N8N_JOB_WEBHOOK_URL not configured',
        detail: 'Cannot forward job to n8n',
        request_id,
        code: 'E_CONFIG',
        client_id: input.client_id || null
      });
      return json({ error: 'Missing N8N_JOB_WEBHOOK_URL' }, 500);
    }

    const secret = String(process.env.FORWARD_SECRET || '');
    const ts = Math.floor(Date.now() / 1000).toString();
    const channel = 'shopify-proxy';

    // Callback back to our /done function
    const u = new URL(req.url);
    u.pathname = '/.netlify/functions/done';
    u.search = '';                               // clear App Proxy qs (shop, timestamp, signature, etc.)
    u.searchParams.set('token', secret);         // add only what we need
    const callback = u.toString();

    const headers = {
      'content-type': 'application/json',
      'x-seoboss-forward-secret': secret,
      'x-seoboss-ts': ts,
      'x-shop': shop,
      'x-channel': channel,
      'x-request-id': request_id,  // ✅ ADD THIS - Forward correlation ID to n8n
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
      
      // ✅ ADD THIS - Log if n8n returns error
      if (!resp.ok) {
        await errlog({
          shop,
          route: '/start',
          status: resp.status,
          message: 'n8n job webhook returned error',
          detail: `jobId: ${jobId}, n8n response: ${n8nText}`,
          request_id,
          code: 'E_N8N_FAILED',
          client_id: input.client_id || null
        });
      }
    } catch (e) {
      n8nErr = String(e);
      
      // ✅ ADD THIS - Log n8n fetch failure
      await errlog({
        shop,
        route: '/start',
        status: 500,
        message: 'Failed to reach n8n job webhook',
        detail: `jobId: ${jobId}, error: ${n8nErr}`,
        request_id,
        code: 'E_N8N_UNREACHABLE',
        client_id: input.client_id || null
      });
    }

    return json({
      ok: true,
      jobId,
      debug: { n8nUrl, n8nStatus, n8nText, n8nErr, callback, shop, ts, channel }
    });

  } catch (e) {
    // ✅ ADD THIS - Log uncaught exceptions
    const url = new URL(req.url);
    const shop = url.searchParams.get('shop') || 'unknown';
    
    await errlog({
      shop,
      route: '/start',
      status: 500,
      message: 'Uncaught exception in start endpoint',
      detail: e.stack || String(e),
      request_id,
      code: 'E_EXCEPTION'
    });

    return json({ error: 'internal', detail: String(e) }, 500);
  }
};
