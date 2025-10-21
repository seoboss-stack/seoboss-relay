// vault-list.mjs — keyed by x-shop, dual-auth (with flexible limits)
import { verifyRequest, getSheetsClient, lookupClientSheetByShop, corsWrap, tenantFrom } from './shared.mjs';
import { readAllRowsAsDicts } from './sheets-dynamic.mjs';
import { errlog } from './_lib/_errlog.mjs';  // ✅ ADD THIS

export default async (req, context) => {
  // ✅ ADD THIS - Extract request_id early
  const request_id = req.headers.get('x-request-id') || req.headers.get('X-Request-Id') || '';
  
  // ✅ Proper 204 for preflight (no body)
  if (req.method === 'OPTIONS') return corsWrap({ status: 204 });

  try {
    const auth = verifyRequest(req);
    if (!auth.ok) {
      return corsWrap(new Response(JSON.stringify({ error:'unauthorized', mode:auth.mode }), { status: 401 }));
    }

    const { shop, client_id } = tenantFrom(req);

    // ✅ ADD THIS - Wrap Sheets connection with error logging
    let sheets, sheetId, tab;
    try {
      sheets = await getSheetsClient();
      const result = await lookupClientSheetByShop({ sheets, shopDomain: shop, clientId: client_id });
      sheetId = result.sheetId;
      tab = result.tab;
    } catch (err) {
      await errlog({
        shop,
        route: '/vault-list',
        status: 500,
        message: 'Failed to connect to Google Sheets',
        detail: err.message || String(err),
        request_id,
        code: 'E_SHEETS_CONNECTION',
        client_id
      });
      throw err;
    }

    if (!sheetId) {
      // ✅ ADD THIS - Log missing sheet configuration
      await errlog({
        shop,
        route: '/vault-list',
        status: 500,
        message: 'No sheet configured for this shop',
        detail: `shop: ${shop}, client_id: ${client_id}`,
        request_id,
        code: 'E_SHEETS_NOT_CONFIGURED',
        client_id
      });
      throw new Error('No sheet configured for this shop');
    }

    const url = new URL(req.url);
    const limitQueuedParam = (url.searchParams.get('limitQueued') || '').trim().toLowerCase();
    const limitPublishedParam = (url.searchParams.get('limitPublished') || '').trim().toLowerCase();
    const limitQueued = (limitQueuedParam === 'all' || limitQueuedParam === '0') ? 0 : Number(limitQueuedParam || 7);
    const limitPublished = (limitPublishedParam === 'all' || limitPublishedParam === '0') ? 0 : Number(limitPublishedParam || 10);

    const norm = (s)=> String(s||'').trim().toLowerCase();

    // ✅ ADD THIS - Wrap sheet read with error logging
    let rows;
    try {
      rows = await readAllRowsAsDicts(sheets, sheetId, tab);
    } catch (err) {
      await errlog({
        shop,
        route: '/vault-list',
        status: 500,
        message: 'Failed to read vault rows from Google Sheets',
        detail: err.message || String(err),
        request_id,
        code: 'E_SHEETS_READ',
        client_id
      });
      throw err;
    }

    const ideas = rows.filter(r => norm(r.status) === 'idea');

    const parseDate = (s) => (s ? new Date(s) : null);
    const asMs = (d) => d?.getTime() || 0;

    const queuedAll = rows
      .filter(r => norm(r.status) === 'queued')
      .sort((a,b) => asMs(parseDate(b.updated_at)) - asMs(parseDate(a.updated_at)));

    // real "next 7 days" based on scheduled_for
    const nowMs = Date.now();
    const in7Ms = nowMs + 7*24*60*60*1000;
    const toMs = (x) => { const t = x ? Date.parse(x) : NaN; return Number.isNaN(t) ? NaN : t; };

    const queued_next7 = queuedAll.filter(r => {
      const t = toMs(r.scheduled_for);
      return !Number.isNaN(t) && t >= nowMs && t <= in7Ms;
    });

    const queued_limited = limitQueued > 0 ? queuedAll.slice(0, limitQueued) : queuedAll;

    const publishedAll = rows
      .filter(r => norm(r.status) === 'published')
      .sort((a,b) => asMs(parseDate(b.updated_at)) - asMs(parseDate(a.updated_at)));

    const published_limited = limitPublished > 0 ? publishedAll.slice(0, limitPublished) : publishedAll;

    const payload = {
      ideas,
      queued: queuedAll,
      queued_next7,
      queued_limited,
      published: publishedAll,
      published_last10: publishedAll.slice(0, 10),
      published_limited,
      counts: {
        ideas: ideas.length,
        queued: queuedAll.length,
        published: publishedAll.length
      }
    };

    return corsWrap(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));

  } catch (err) {
    // ✅ ADD THIS - Log uncaught exceptions
    const { shop, client_id } = tenantFrom(req);
    await errlog({
      shop,
      route: '/vault-list',
      status: 500,
      message: 'Uncaught exception in vault-list',
      detail: err.stack || err.message || String(err),
      request_id,
      code: 'E_EXCEPTION',
      client_id
    });

    return corsWrap(new Response(JSON.stringify({ error: err.message || String(err) }), { status: 500 }));
  }
};
