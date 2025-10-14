// netlify/functions/vault-add.mjs — keyed by x-shop, dual-auth, UUID id
import { verifyRequest, getSheetsClient, lookupClientSheetByShop, corsWrap, tenantFrom } from './shared.mjs';
import { appendRowFromDict, readAllRowsAsDicts } from './sheets-dynamic.mjs';
import { randomUUID } from 'node:crypto';

export default async (req, context) => {
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
    const sheets = await getSheetsClient();
    const { sheetId, tab } = await lookupClientSheetByShop({ sheets, shopDomain: shop, clientId: client_id });
    if (!sheetId) throw new Error('No sheet configured for this shop');

    // Make a unique vault_id (compact UUID) with a quick collision check
    const makeUniqueVaultId = async () => {
      const rows = await readAllRowsAsDicts(sheets, sheetId, tab);
      const existing = new Set(rows.map(r => String(r.vault_id || '')));
      let id = clean(body.vault_id) || randomUUID().replace(/-/g, '');
      while (existing.has(id)) id = randomUUID().replace(/-/g, '');
      return id;
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

    await appendRowFromDict(sheets, sheetId, tab, row);

    return corsWrap(new Response(JSON.stringify({ ok:true, row }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
  } catch (err) {
    return corsWrap(new Response(JSON.stringify({ error: err.message || String(err) }), { status: 500 }));
  }
};
