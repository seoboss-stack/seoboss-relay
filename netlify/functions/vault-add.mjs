// netlify/functions/vault-add.mjs — keyed by x-shop, dual-auth, UUID id
import { verifyRequest, getSheetsClient, lookupClientSheetByShop, corsWrap, tenantFrom } from './shared.mjs';
import { appendRowFromDict, readAllRowsAsDicts } from './sheets-dynamic.mjs';
import { randomUUID } from 'node:crypto';
import { errlog } from './_lib/_errlog.mjs';  // ✅ ADD THIS

export default async (req, context) => {
  // ✅ ADD THIS - Extract request_id early
  const request_id = req.headers.get('x-request-id') || req.headers.get('X-Request-Id') || '';
  
  // ✅ Proper 204 for preflight
  if (req.method === 'OPTIONS') return corsWrap({ status: 204 });

  try {
    // Only allow POST for writes
    if (req.method !== 'POST') {
      return corsWrap(new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405 }));
    }

    const auth = verifyRequest(req);
    if (!auth.ok) {
      return corsWrap(new Response(JSON.stringify({ error:'unauthorized', mode:auth.mode }), { status: 401 }));
    }

    const { shop, client_id } = tenantFrom(req);
    let body = {};
    try { body = await req.json(); } catch { body = {}; }

    const now = new Date().toISOString();
    const clean = (v) => (v == null ? '' : String(v).trim());

    // Sheets client + tenant sheet/tab
    let sheets, sheetId, tab;
    try {
      sheets = await getSheetsClient();
      const result = await lookupClientSheetByShop({ sheets, shopDomain: shop, clientId: client_id });
      sheetId = result.sheetId;
      tab = result.tab;
    } catch (err) {
      // ✅ ADD THIS - Log Google Sheets client/lookup failure
      await errlog({
        shop,
        route: '/vault-add',
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
        route: '/vault-add',
        status: 500,
        message: 'No sheet configured for this shop',
        detail: `shop: ${shop}, client_id: ${client_id}`,
        request_id,
        code: 'E_SHEETS_NOT_CONFIGURED',
        client_id
      });
      throw new Error('No sheet configured for this shop');
    }

    // Make a unique vault_id (compact UUID) with a quick collision check
    const makeUniqueVaultId = async () => {
      try {
        const rows = await readAllRowsAsDicts(sheets, sheetId, tab);
        const existing = new Set(rows.map(r => String(r.vault_id || '')));
        let id = clean(body.vault_id) || randomUUID().replace(/-/g, '');
        while (existing.has(id)) id = randomUUID().replace(/-/g, '');
        return id;
      } catch (err) {
        // ✅ ADD THIS - Log sheet read failure
        await errlog({
          shop,
          route: '/vault-add',
          status: 500,
          message: 'Failed to read vault rows for ID collision check',
          detail: err.message || String(err),
          request_id,
          code: 'E_SHEETS_READ',
          client_id
        });
        throw err;
      }
    };

    // Normalize status
    const statusIn = clean(body.status).toLowerCase();
    const status = statusIn || 'idea';

    const row = {
      vault_id: await makeUniqueVaultId(),
      client_id: clean(client_id),
      shop_url: clean(shop),
      shop_client_id: clean(body.shop_client_id),
      title: clean(body.title),
      meta_title: clean(body.meta_title),
      meta_description: clean(body.meta_description),
      target_keywords: clean(body.target_keywords),
      category: clean(body.category),
      language: clean(body.language),
      status,
      created_at: now,
      updated_at: now,
      notes: clean(body.notes),
      idea_source: clean(body.idea_source) || 'generator',
      scheduled_for: clean(body.scheduled_for),
      published_at: ''
    };

    try {
      await appendRowFromDict(sheets, sheetId, tab, row);
    } catch (err) {
      // ✅ ADD THIS - Log sheet append failure
      await errlog({
        shop,
        route: '/vault-add',
        status: 500,
        message: 'Failed to append row to Google Sheets',
        detail: err.message || String(err),
        request_id,
        code: 'E_SHEETS_WRITE',
        client_id
      });
      throw err;
    }

    return corsWrap(new Response(JSON.stringify({ ok:true, row }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));

  } catch (err) {
    // ✅ ADD THIS - Log uncaught exceptions
    const { shop, client_id } = tenantFrom(req);
    await errlog({
      shop,
      route: '/vault-add',
      status: 500,
      message: 'Uncaught exception in vault-add',
      detail: err.stack || err.message || String(err),
      request_id,
      code: 'E_EXCEPTION',
      client_id
    });

    return corsWrap(new Response(JSON.stringify({ error: err.message || String(err) }), { status: 500 }));
  }
};
