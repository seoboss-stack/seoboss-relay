// sheets-dynamic.mjs — header-agnostic helpers
export async function getHeaderMap(sheets, spreadsheetId, tab) {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!1:1`
  });
  const header = (data.values && data.values[0]) || [];
  const map = new Map();
  header.forEach((name, idx) => map.set((name||'').trim(), idx));
  return { header, map };
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
  const { header } = await getHeaderMap(sheets, spreadsheetId, tab);
  const row = toRowArrayFromDict(header, dict);
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A1:${columnLetter(header.length)}1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });
}

export async function updateRowFieldsById(sheets, spreadsheetId, tab, idFieldName, idValue, updates) {
  const { header, map } = await getHeaderMap(sheets, spreadsheetId, tab);
  const idCol = map.get(idFieldName);
  if (idCol == null) throw new Error(`Column '${idFieldName}' not found`);

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A2:${columnLetter(header.length)}10000`
  });
  const rows = data.values || [];
  let rowIndex = -1;
  for (let i=0;i<rows.length;i++){
    const r = rows[i];
    if ((r[idCol]||'') === idValue){ rowIndex = i; break; }
  }
  if (rowIndex < 0) throw new Error(`Row with ${idFieldName}=${idValue} not found`);

  const updated = header.map((name, idx) => {
    const newVal = (updates.hasOwnProperty(name)) ? (updates[name] ?? '') : rows[rowIndex][idx] || '';
    return String(newVal);
  });

  const rowNumber = rowIndex + 2;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A${rowNumber}:${columnLetter(header.length)}${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [updated] }
  });
}

function toRowArrayFromDict(header, dict) {
  const arr = Array(header.length).fill('');
  header.forEach((name, idx) => {
    const key = (name||'').trim();
    if (key && dict.hasOwnProperty(key)) arr[idx] = dict[key] == null ? '' : String(dict[key]);
  });
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
    let mod = (num-1) % 26;
    s = String.fromCharCode(65+mod) + s;
    num = Math.floor((num-1)/26);
  }
  return s || 'A';
}
