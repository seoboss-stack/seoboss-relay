// vault-list.mjs — keyed by x-shop, dual-auth (with flexible limits)
import { verifyRequest, getSheetsClient, lookupClientSheetByShop, corsWrap, tenantFrom } from './shared.mjs';
import { readAllRowsAsDicts } from './sheets-dynamic.mjs';

export default async (req, context) => {
  if (req.method === 'OPTIONS') return corsWrap(new Response('', { status: 204 }));
  try {
    const auth = verifyRequest(req);
    if (!auth.ok) {
      return corsWrap(new Response(JSON.stringify({ error:'unauthorized', mode:auth.mode }), { status: 401 }));
    }

    const { shop, client_id } = tenantFrom(req);
    const sheets = await getSheetsClient();
    const { sheetId, tab } = await lookupClientSheetByShop({ sheets, shopDomain: shop, clientId: client_id });
    if (!sheetId) throw new Error('No sheet configured for this shop');

    const url = new URL(req.url);
    const limitQueuedParam = (url.searchParams.get('limitQueued') || '').trim().toLowerCase();
    const limitPublishedParam = (url.searchParams.get('limitPublished') || '').trim().toLowerCase();

    // Defaults keep your old behavior
    const limitQueued = (limitQueuedParam === 'all' || limitQueuedParam === '0') ? 0 : Number(limitQueuedParam || 7);
    const limitPublished = (limitPublishedParam === 'all' || limitPublishedParam === '0') ? 0 : Number(limitPublishedParam || 10);

    const norm = (s)=> String(s||'').trim().toLowerCase();
    const rows = await readAllRowsAsDicts(sheets, sheetId, tab);

    const ideas = rows.filter(r => norm(r.status) === 'idea');

    const queuedAll = rows.filter(r => norm(r.status) === 'queued')
                          .sort((a,b)=> String(b.updated_at||'').localeCompare(String(a.updated_at||'')));
    const queuedLimited = limitQueued > 0 ? queuedAll.slice(0, limitQueued) : queuedAll;

    const publishedAll = rows.filter(r => norm(r.status) === 'published')
                             .sort((a,b)=> String(b.updated_at||'').localeCompare(String(a.updated_at||'')));
    const publishedLimited = limitPublished > 0 ? publishedAll.slice(0, limitPublished) : publishedAll;

    // Backward-compat keys + full lists
    const payload = {
      ideas,
      queued: queuedAll,                                 // full list
      queued_next7: queuedAll.slice(0, 7),               // legacy key
      queued_limited: queuedLimited,                     // limited by query

      published: publishedAll,                           // full list
      published_last10: publishedAll.slice(0, 10),       // legacy key
      published_limited: publishedLimited,               // limited by query

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
    return corsWrap(new Response(JSON.stringify({ error: err.message || String(err) }), { status: 500 }));
  }
};
