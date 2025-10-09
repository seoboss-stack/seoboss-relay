// vault-list.mjs — keyed by x-shop, dual-auth
import { verifyRequest, getSheetsClient, lookupClientSheetByShop, corsWrap, tenantFrom } from './shared.mjs';
import { readAllRowsAsDicts } from './sheets-dynamic.mjs';

export default async (req, context) => {
  if (req.method === 'OPTIONS') return corsWrap(new Response('', { status: 204 }));
  try{
    const auth = verifyRequest(req);
    if (!auth.ok) return corsWrap(new Response(JSON.stringify({ error:'unauthorized', mode:auth.mode }), { status: 401 }));

    const { shop, client_id } = tenantFrom(req);
    const sheets = await getSheetsClient();
    const { sheetId, tab } = await lookupClientSheetByShop({ sheets, shopDomain: shop, clientId: client_id });
    if (!sheetId) throw new Error('No sheet configured for this shop');

    const rows = await readAllRowsAsDicts(sheets, sheetId, tab);
    const norm = (s)=> String(s||'').trim().toLowerCase();
    const ideas = rows.filter(r => norm(r.status)==='idea');
    const queued = rows.filter(r => norm(r.status)==='queued');
    const published = rows.filter(r => norm(r.status)==='published')
                          .sort((a,b)=> String(b.updated_at||'').localeCompare(String(a.updated_at||'')));
    return corsWrap(new Response(JSON.stringify({ ideas, queued_next7: queued.slice(0,7), published: published.slice(0,10) }), { status:200, headers:{'content-type':'application/json'} }));
  }catch(err){
    return corsWrap(new Response(JSON.stringify({ error: err.message || String(err) }), { status: 500 }));
  }
};
