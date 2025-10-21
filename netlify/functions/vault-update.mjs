// vault-update.mjs — keyed by x-shop, dual-auth
import { verifyRequest, getSheetsClient, lookupClientSheetByShop, corsWrap, tenantFrom } from './shared.mjs';
import { updateRowFieldsById } from './sheets-dynamic.mjs';
import { errlog } from './_lib/_errlog.mjs';  // ✅ ADD THIS

export default async (req, context) => {
  // ✅ ADD THIS - Extract request_id early
  const request_id = req.headers.get('x-request-id') || req.headers.get('X-Request-Id') || '';
  
  // ✅ Proper 204 for preflight
  if (req.method === 'OPTIONS') return corsWrap({ status: 204 });

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
        route: '/vault-update',
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
        route: '/vault-update',
        status: 500,
        message: 'No sheet configured for this shop',
        detail: `shop: ${shop}, client_id: ${client_id}`,
        request_id,
        code: 'E_SHEETS_NOT_CONFIGURED',
        client_id
      });
      throw new Error('No sheet configured for this shop');
    }

    const now = new Date().toISOString();
    const updatesNorm = {};
    for (const [k,v] of Object.entries(updates)) {
      updatesNorm[k] = v == null ? '' : String(v);
    }
    updatesNorm.updated_at = now;

    // ✅ ADD THIS - Wrap sheet update with error logging
    try {
      await updateRowFieldsById(sheets, sheetId, tab, 'vault_id', String(vault_id), updatesNorm);
    } catch (err) {
      await errlog({
        shop,
        route: '/vault-update',
        status: 500,
        message: 'Failed to update vault row in Google Sheets',
        detail: `vault_id: ${vault_id}, error: ${err.message || String(err)}`,
        request_id,
        code: 'E_SHEETS_WRITE',
        client_id
      });
      throw err;
    }

    return corsWrap(new Response(JSON.stringify({ ok:true }), {
      status:200, headers:{'content-type':'application/json'}
    }));

  } catch (err) {
    // ✅ ADD THIS - Log uncaught exceptions
    const { shop, client_id } = tenantFrom(req);
    await errlog({
      shop,
      route: '/vault-update',
      status: 500,
      message: 'Uncaught exception in vault-update',
      detail: err.stack || err.message || String(err),
      request_id,
      code: 'E_EXCEPTION',
      client_id
    });

    return corsWrap(new Response(JSON.stringify({ error: err.message || String(err) }), { status: 500 }));
  }
};
