// netlify/functions/vault-delete.mjs — keyed by x-shop, dual-auth
import { verifyRequest, getSheetsClient, lookupClientSheetByShop, corsWrap, tenantFrom } from './shared.mjs';
import { errlog } from './_lib/_errlog.mjs';  // ✅ ADD THIS

export default async (req, context) => {
  // ✅ ADD THIS - Extract request_id early
  const request_id = req.headers.get('x-request-id') || req.headers.get('X-Request-Id') || '';
  
  // Proper 204 for preflight
  if (req.method === 'OPTIONS') return corsWrap({ status: 204 });

  try {
    const auth = verifyRequest(req);
    if (!auth.ok) {
      return corsWrap(new Response(JSON.stringify({ error:'unauthorized', mode:auth.mode }), { status: 401 }));
    }

    if (req.method !== 'POST') {
      return corsWrap(new Response(JSON.stringify({ error:'method_not_allowed' }), { status: 405 }));
    }

    const { shop, client_id } = tenantFrom(req);

    let body = {};
    try { body = await req.json(); } catch { body = {}; }
    const vault_id = String(body?.vault_id || '').trim();
    if (!vault_id) {
      return corsWrap(new Response(JSON.stringify({ error:'vault_id required' }), { status: 400 }));
    }

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
        route: '/vault-delete',
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
        route: '/vault-delete',
        status: 500,
        message: 'No sheet configured for this shop',
        detail: `shop: ${shop}, client_id: ${client_id}`,
        request_id,
        code: 'E_SHEETS_NOT_CONFIGURED',
        client_id
      });
      throw new Error('No sheet configured for this shop');
    }

    // 1) Read header to locate columns
    let header, headerLower, idColIdx;
    try {
      const { data: headerResp } = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${String(tab).replace(/'/g,"''")}'!1:1`,
      });
      header = (headerResp.values && headerResp.values[0]) || [];
      headerLower = header.map(h => String(h||'').trim().toLowerCase());
      idColIdx = headerLower.indexOf('vault_id');
      if (idColIdx < 0) throw new Error(`Column 'vault_id' not found in tab '${tab}'`);
    } catch (err) {
      // ✅ ADD THIS - Log header read failure
      await errlog({
        shop,
        route: '/vault-delete',
        status: 500,
        message: 'Failed to read sheet header',
        detail: err.message || String(err),
        request_id,
        code: 'E_SHEETS_READ',
        client_id
      });
      throw err;
    }

    // 2) Read data block to find the row index
    let rows, rowIndex = -1;
    try {
      const { data: rowsResp } = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${String(tab).replace(/'/g,"''")}'!A2:${columnLetter(header.length)}10000`,
      });
      rows = rowsResp.values || [];

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] || [];
        if (String(r[idColIdx] || '') === vault_id) {
          rowIndex = i;
          break;
        }
      }
    } catch (err) {
      // ✅ ADD THIS - Log data read failure
      await errlog({
        shop,
        route: '/vault-delete',
        status: 500,
        message: 'Failed to read vault data',
        detail: err.message || String(err),
        request_id,
        code: 'E_SHEETS_READ',
        client_id
      });
      throw err;
    }

    if (rowIndex < 0) {
      // Not an error - just not found (404 is appropriate)
      return corsWrap(new Response(JSON.stringify({ ok:false, error:`vault_id '${vault_id}' not found` }), {
        status: 404, headers:{'content-type':'application/json'}
      }));
    }

    // 3) Compute absolute sheet row number (incl. header)
    // header is row 1, data starts at row 2 → add 2
    const sheetRowNumber = rowIndex + 2;

    // 4) Get numeric sheet ID (gid)
    let gid;
    try {
      gid = await sheetIdFromTab(sheets, sheetId, tab);
    } catch (err) {
      // ✅ ADD THIS - Log sheet ID lookup failure
      await errlog({
        shop,
        route: '/vault-delete',
        status: 500,
        message: 'Failed to lookup sheet ID (gid)',
        detail: `tab: ${tab}, error: ${err.message || String(err)}`,
        request_id,
        code: 'E_SHEETS_READ',
        client_id
      });
      throw err;
    }

    // 5) Delete row via batchUpdate
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId: gid,
                dimension: 'ROWS',
                startIndex: sheetRowNumber - 1, // zero-based, inclusive
                endIndex: sheetRowNumber,       // zero-based, exclusive
              }
            }
          }]
        }
      });
    } catch (err) {
      // ✅ ADD THIS - Log delete operation failure
      await errlog({
        shop,
        route: '/vault-delete',
        status: 500,
        message: 'Failed to delete row from Google Sheets',
        detail: `vault_id: ${vault_id}, row: ${sheetRowNumber}, error: ${err.message || String(err)}`,
        request_id,
        code: 'E_SHEETS_DELETE',
        client_id
      });
      throw err;
    }

    return corsWrap(new Response(JSON.stringify({ ok:true, vault_id }), {
      status:200, headers:{'content-type':'application/json'}
    }));

  } catch (err) {
    // ✅ ADD THIS - Log uncaught exceptions
    const { shop, client_id } = tenantFrom(req);
    await errlog({
      shop,
      route: '/vault-delete',
      status: 500,
      message: 'Uncaught exception in vault-delete',
      detail: err.stack || err.message || String(err),
      request_id,
      code: 'E_EXCEPTION',
      client_id
    });

    return corsWrap(new Response(JSON.stringify({ error: err.message || String(err) }), { status: 500 }));
  }
};

/* helpers (local to this file) */
function columnLetter(n) {
  let s = ''; let num = n;
  while (num > 0) {
    const mod = (num - 1) % 26;
    s = String.fromCharCode(65 + mod) + s;
    num = Math.floor((num - 1) / 26);
  }
  return s || 'A';
}

async function sheetIdFromTab(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = (meta.data.sheets || []).find(s => {
    const title = s.properties?.title || '';
    return title.trim() === String(tabName).trim();
  });
  if (!sheet) throw new Error(`Tab '${tabName}' not found`);
  const gid = sheet.properties?.sheetId;
  if (typeof gid !== 'number') throw new Error(`sheetId for tab '${tabName}' not found`);
  return gid;
}
