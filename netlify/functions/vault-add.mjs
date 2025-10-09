// vault-add.mjs — keyed by x-shop, dual-auth
import { verifyRequest, getSheetsClient, lookupClientSheetByShop, corsWrap, tenantFrom } from './shared.mjs';
import { appendRowFromDict } from './sheets-dynamic.mjs';

export default async (req, context) => {
  if (req.method === 'OPTIONS') return corsWrap(new Response('', { status: 204 }));
  try{
    const auth = verifyRequest(req);
    if (!auth.ok) return corsWrap(new Response(JSON.stringify({ error:'unauthorized', mode:auth.mode }), { status: 401 }));

    const { shop, client_id } = tenantFrom(req);
    const body = await req.json();
    const now = new Date().toISOString();

    const row = {
      vault_id: body.vault_id || (Math.random().toString(36).slice(2) + Date.now().toString(36)),
      client_id,
      shop_url: shop,
      shop_client_id: body.shop_client_id || '',
      title: body.title || '',
      meta_title: body.meta_title || '',
      meta_description: body.meta_description || '',
      target_keywords: body.target_keywords || '',
      category: body.category || '',
      language: body.language || '',
      status: (body.status || 'idea'),
      created_at: now,
      updated_at: now,
      notes: body.notes || '',
      idea_source: body.idea_source || 'generator'
    };

    const sheets = await getSheetsClient();
    const { sheetId, tab } = await lookupClientSheetByShop({ sheets, shopDomain: shop, clientId: client_id });
    if (!sheetId) throw new Error('No sheet configured for this shop');

    await appendRowFromDict(sheets, sheetId, tab, row);
    return corsWrap(new Response(JSON.stringify({ ok:true, row }), { status:200, headers:{'content-type':'application/json'} }));
  }catch(err){
    return corsWrap(new Response(JSON.stringify({ error: err.message || String(err) }), { status: 500 }));
  }
};
