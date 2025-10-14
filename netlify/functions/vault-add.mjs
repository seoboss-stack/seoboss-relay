// vault-add.mjs — keyed by x-shop, dual-auth
import { verifyRequest, getSheetsClient, lookupClientSheetByShop, corsWrap, tenantFrom } from './shared.mjs';
import { appendRowFromDict } from './sheets-dynamic.mjs';

export default async (req, context) => {
  // ✅ Proper 204 for preflight
  if (req.method === 'OPTIONS') return corsWrap({ status: 204 });

  try {
    const auth = verifyRequest(req);
    if (!auth.ok) return corsWrap(new Response(JSON.stringify({ error:'unauthorized', mode:auth.mode }), { status: 401 }));

    const { shop, client_id } = tenantFrom(req);

    let body = {};
    try { body = await req.json(); } catch { body = {}; }

    const now = new Date().toISOString();
    const clean = (v) => (v == null ? '' : String(v).trim());

    const row = {
      vault_id: clean(body.vault_id) || (Math.random().toString(36).slice(2) + Date.now().toString(36)),
      client_id: clean(client_id),
      shop_url: clean(shop),
      shop_client_id: clean(body.shop_client_id),
      title: clean(body.title),
      meta_title: clean(body.meta_title),
      meta_description: clean(body.meta_description),
      target_keywords: clean(body.target_keywords),
      category: clean(body.category),
      language: clean(body.language),
      status: clean(body.status).toLowerCase() || 'idea',
      created_at: now,
      updated_at: now,
      notes: clean(body.notes),
      idea_source: clean(body.idea_source) || 'generator',
      scheduled_for: clean(body.scheduled_for),
      published_at: ''
    };

    const sheets = await getSheetsClient();
    const { sheetId, tab } = await lookupClientSheetByShop({ sheets, shopDomain: shop, clientId: client_id });
    if (!sheetId) throw new Error('No sheet configured for this shop');

    await appendRowFromDict(sheets, sheetId, tab, row);

    return corsWrap(new Response(JSON.stringify({ ok:true, row }), {
      status:200, headers:{'content-type':'application/json'}
    }));
  } catch (err) {
    return corsWrap(new Response(JSON.stringify({ error: err.message || String(err) }), { status: 500 }));
  }
};
