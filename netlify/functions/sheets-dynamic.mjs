// sheets-dynamic.mjs — header-agnostic helpers (case-insensitive + id coercion)
export async function getHeaderMap(sheets, spreadsheetId, tab) {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!1:1`
  });
  const header = (data.values && data.values[0]) || [];
  const map = new Map();
  const mapLower = new Map();
  header.forEach((name, idx) => {
    const key = String(name || '').trim();
    map.set(key, idx);
    mapLower.set(key.toLowerCase(), idx);
  });
  return { header, map, mapLower };
}

export async function readAllRowsAsDicts(sheets, spreadsheetId, tab) {
  const { header } = await getHeaderMap(sheets, spreadsheetId, tab);
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A2:${columnLetter(header.length)}10000`
  });
  const rows = (data.values || []);
  return rows.map(r => dictFromRow(header, r));
}

export async function appendRowFromDict(sheets, spreadsheetId, tab, dict) {
  const { header, map, mapLower } = await getHeaderMap(sheets, spreadsheetId, tab);
  const row = toRowArrayFromDict(header, dict, map, mapLower);
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A1:${columnLetter(header.length)}1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });
}

export async function updateRowFieldsById(sheets, spreadsheetId, tab, idFieldName, idValue, updates) {
  const { header, map, mapLower } = await getHeaderMap(sheets, spreadsheetId, tab);
  const idCol = map.get(idFieldName) ?? mapLower.get(String(idFieldName).toLowerCase());
  if (idCol == null) throw new Error(`Column '${idFieldName}' not found`);

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A2:${columnLetter(header.length)}10000`
  });
  const rows = data.values || [];
  const want = String(idValue); // ← ensure string compare
  let rowIndex = -1;
  for (let i=0;i<rows.length;i++){
    const cell = rows[i][idCol] == null ? '' : String(rows[i][idCol]);
    if (cell === want){ rowIndex = i; break; }
  }
  if (rowIndex < 0) throw new Error(`Row with ${idFieldName}=${want} not found`);

  // Build updated row by header names (case-insensitive keys in updates)
  const updatesLower = Object.fromEntries(
    Object.entries(updates || {}).map(([k,v]) => [String(k).toLowerCase(), v == null ? '' : String(v)])
  );

  const updated = header.map((name, idx) => {
    const key = String(name || '');
    const lower = key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(updatesLower, lower)) {
      return updatesLower[lower];
    }
    const prev = rows[rowIndex][idx];
    return prev == null ? '' : String(prev);
  });

  const rowNumber = rowIndex + 2; // + header row
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A${rowNumber}:${columnLetter(header.length)}${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [updated] }
  });
}

function toRowArrayFromDict(header, dict, map, mapLower) {
  const arr = Array(header.length).fill('');
  const entries = Object.entries(dict || {});
  for (const [k, val] of entries) {
    const key = String(k || '').trim();
    const idx = map.get(key) ?? mapLower.get(key.toLowerCase());
    if (idx != null) arr[idx] = val == null ? '' : String(val);
  }
  return arr;
}

function dictFromRow(header, row) {
  const obj = {};
  header.forEach((name, idx) => { obj[name] = row[idx] || ''; });
  return obj;
}

function columnLetter(n){
  let s = ''; let num = n;
  while (num > 0){
    const mod = (num-1) % 26;
    s = String.fromCharCode(65+mod) + s;
    num = Math.floor((num-1)/26);
  }
  return s || 'A';
}
