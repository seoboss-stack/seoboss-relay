// netlify/functions/vault-delete.mjs — keyed by x-shop, dual-auth
import { verifyRequest, getSheetsClient, lookupClientSheetByShop, corsWrap, tenantFrom } from './shared.mjs';

export default async (req, context) => {
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

    const sheets = await getSheetsClient();
    const { sheetId, tab } = await lookupClientSheetByShop({ sheets, shopDomain: shop, clientId: client_id });
    if (!sheetId) throw new Error('No sheet configured for this shop');

    // 1) Read header to locate columns
    const { data: headerResp } = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${String(tab).replace(/'/g,"''")}'!1:1`,
    });
    const header = (headerResp.values && headerResp.values[0]) || [];
    const headerLower = header.map(h => String(h||'').trim().toLowerCase());
    const idColIdx = headerLower.indexOf('vault_id');
    if (idColIdx < 0) throw new Error(`Column 'vault_id' not found in tab '${tab}'`);

    // 2) Read data block to find the row index
    const { data: rowsResp } = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${String(tab).replace(/'/g,"''")}'!A2:${columnLetter(header.length)}10000`,
    });
    const rows = rowsResp.values || [];

    let rowIndex = -1; // 0-based within the data region (A2 = index 0)
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || [];
      if (String(r[idColIdx] || '') === vault_id) {
        rowIndex = i;
        break;
      }
    }
    if (rowIndex < 0) {
      return corsWrap(new Response(JSON.stringify({ ok:false, error:`vault_id '${vault_id}' not found` }), {
        status: 404, headers:{'content-type':'application/json'}
      }));
    }

    // 3) Compute absolute sheet row number (incl. header)
    // header is row 1, data starts at row 2 → add 2
    const sheetRowNumber = rowIndex + 2;

    // 4) Delete row via batchUpdate → deleteDimension on ROWS
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: await sheetIdFromTab(sheets, sheetId, tab), // numeric gid
              dimension: 'ROWS',
              startIndex: sheetRowNumber - 1, // zero-based, inclusive
              endIndex: sheetRowNumber,       // zero-based, exclusive
            }
          }
        }]
      }
    });

    return corsWrap(new Response(JSON.stringify({ ok:true, vault_id }), {
      status:200, headers:{'content-type':'application/json'}
    }));
  } catch (err) {
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
