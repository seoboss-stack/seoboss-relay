// vault-update.mjs — keyed by x-shop, dual-auth
import { verifyRequest, getSheetsClient, lookupClientSheetByShop, corsWrap, tenantFrom } from './shared.mjs';
import { updateRowFieldsById } from './sheets-dynamic.mjs';

export default async (req, context) => {
  if (req.method === 'OPTIONS') return corsWrap(new Response('', { status: 204 }));
  try {
    const auth = verifyRequest(req);
    if (!auth.ok) {
      return corsWrap(new Response(JSON.stringify({ error:'unauthorized', mode:auth.mode }), { status: 401 }));
    }

    const { shop, client_id } = tenantFrom(req);

    let body = {};
    try { body = await req.json(); } catch { body = {}; }

    const { vault_id } = body || {};
    const updates = body?.updates || {};
    if (!vault_id) throw new Error('vault_id required');

    const sheets = await getSheetsClient();
    const { sheetId, tab } = await lookupClientSheetByShop({ sheets, shopDomain: shop, clientId: client_id });
    if (!sheetId) throw new Error('No sheet configured for this shop');

    const now = new Date().toISOString();
    // Normalize updates to strings (helper is case-insensitive on keys)
    const updatesNorm = {};
    for (const [k,v] of Object.entries(updates)) {
      updatesNorm[k] = v == null ? '' : String(v);
    }
    updatesNorm.updated_at = now;

    await updateRowFieldsById(sheets, sheetId, tab, 'vault_id', String(vault_id), updatesNorm);

    return corsWrap(new Response(JSON.stringify({ ok:true }), {
      status:200, headers:{'content-type':'application/json'}
    }));
  } catch (err) {
    return corsWrap(new Response(JSON.stringify({ error: err.message || String(err) }), { status: 500 }));
  }
};
