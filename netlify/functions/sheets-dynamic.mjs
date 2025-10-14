// sheets-dynamic.mjs — header-agnostic helpers with safe sheet-name quoting
// Keeps your original API (getHeaderMap, readAllRowsAsDicts, appendRowFromDict, updateRowFieldsById)

//
// ─── A1 + UTILS ────────────────────────────────────────────────────────────────
//
function A1(tab, range) {
  // Always single-quote and escape apostrophes in sheet/tab names
  const safe = String(tab || '').trim().replace(/'/g, "''");
  return `'${safe}'!${range}`;
}

function colIdxToA1(colIdx) {
  // 0-based index -> A, B, ..., Z, AA, AB, ...
  let n = (colIdx ?? 0) + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || 'A';
}

function columnLetter(n) {
  // Backward-compat helper (expects a 1-based count); when n=0, return 'A'
  return colIdxToA1(Math.max(0, (n || 1) - 1));
}

function toRowArrayFromDict(header, dict) {
  const arr = Array(header.length).fill('');
  header.forEach((name, idx) => {
    const key = (name || '').trim();
    if (key && Object.prototype.hasOwnProperty.call(dict || {}, key)) {
      const v = dict[key];
      arr[idx] = (v == null) ? '' : String(v);
    }
  });
  return arr;
}

function dictFromRow(header, row = []) {
  const obj = {};
  header.forEach((name, idx) => { obj[(name || '').trim()] = row[idx] ?? ''; });
  return obj;
}

function headerIndexMap(header) {
  const map = new Map();
  header.forEach((name, idx) => map.set(String(name || '').trim(), idx));
  return map;
}

//
// ─── INTERNAL: GET OR CREATE HEADERS ───────────────────────────────────────────
//
async function getHeaderRow(sheets, spreadsheetId, tab) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: A1(tab, 'A1:Z1'),
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const header = (res.data.values?.[0] || []).map(h => String(h || '').trim());
  return header;
}

async function ensureHeadersForKeys(sheets, spreadsheetId, tab, incomingKeys = []) {
  // Load current header
  let header = await getHeaderRow(sheets, spreadsheetId, tab);

  // If no header exists, start with incoming keys (header-agnostic mode)
  if (!header.length && incomingKeys.length) {
    header = incomingKeys.map(k => String(k || '').trim()).filter(Boolean);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: A1(tab, 'A1'),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [header] }
    });
    return header;
  }

  // Add any missing keys to header
  const set = new Set(header.map(h => h.trim()));
  const toAdd = [];
  for (const k of incomingKeys) {
    const key = String(k || '').trim();
    if (key && !set.has(key)) {
      set.add(key);
      toAdd.push(key);
    }
  }
  if (toAdd.length) {
    header = header.concat(toAdd);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: A1(tab, 'A1'),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [header] }
    });
  }
  return header;
}

//
// ─── PUBLIC: GET HEADER MAP (SAFE A1) ──────────────────────────────────────────
//
export async function getHeaderMap(sheets, spreadsheetId, tab) {
  // Replaces `${sheetA1(tab)}!1:1` with safe `'Tab'!A1:Z1`
  const header = await getHeaderRow(sheets, spreadsheetId, tab);
  const map = headerIndexMap(header);
  return { header, map };
}

//
// ─── PUBLIC: READ ALL ROWS AS DICTS (SAFE A1) ──────────────────────────────────
//
export async function readAllRowsAsDicts(sheets, spreadsheetId, tab) {
  const { header } = await getHeaderMap(sheets, spreadsheetId, tab);
  if (!header.length) return []; // empty sheet

  // Use the header length to decide the last column; read all rows from A2
  const lastCol = columnLetter(header.length);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: A1(tab, `A2:${lastCol}`),
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const rows = res.data.values || [];
  return rows.map(r => dictFromRow(header, r));
}

//
// ─── PUBLIC: APPEND A ROW FROM DICT (HEADER-AGNOSTIC + SAFE A1) ────────────────
//
export async function appendRowFromDict(sheets, spreadsheetId, tab, dict) {
  // Ensure headers include all dict keys (creates row 1 if needed)
  const incomingKeys = Object.keys(dict || {});
  const header = await ensureHeadersForKeys(sheets, spreadsheetId, tab, incomingKeys);

  const row = toRowArrayFromDict(header, dict);
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: A1(tab, 'A1'),                 // anchor at header; let API insert rows
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });
}

//
// ─── PUBLIC: UPDATE FIELDS BY ID (HEADER-AGNOSTIC + SAFE A1) ───────────────────
//
export async function updateRowFieldsById(sheets, spreadsheetId, tab, idFieldName, idValue, updates) {
  // Ensure headers include all update keys (adds new columns when missing)
  const updateKeys = Object.keys(updates || {});
  let header = await ensureHeadersForKeys(sheets, spreadsheetId, tab, updateKeys);
  const map = headerIndexMap(header);

  // Find ID column
  const idCol = map.get(String(idFieldName || '').trim());
  if (idCol == null) {
    throw new Error(`Column '${idFieldName}' not found`);
  }

  // Read all data rows (A2 : lastCol)
  const lastCol = columnLetter(header.length);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: A1(tab, `A2:${lastCol}`),
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const rows = res.data.values || [];

  // Locate row index by ID
  const want = String(idValue);
  let rowIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    if (String(r[idCol] ?? '') === want) { rowIndex = i; break; }
  }
  if (rowIndex < 0) {
    throw new Error(`Row with ${idFieldName}=${want} not found`);
  }

  // Merge updates into the existing row
  const current = rows[rowIndex] || [];
  const currentObj = dictFromRow(header, current);
  const nextObj = { ...currentObj, ...Object.fromEntries(
    Object.entries(updates || {}).map(([k, v]) => [String(k).trim(), v == null ? '' : String(v)])
  )};

  const updated = toRowArrayFromDict(header, nextObj);

  // Write the single row back
  const rowNumber = rowIndex + 2; // because A2 is rows[0]
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: A1(tab, `A${rowNumber}:${lastCol}${rowNumber}`),
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [updated] }
  });
}
