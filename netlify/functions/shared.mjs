// shared.mjs — dual-auth (App Proxy HMAC OR Forward Secret) + registry lookup keyed by shop_url
import crypto from 'crypto';
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

/* ───────────── helpers ───────────── */
function A1(tab, range){
  const safe = String(tab).replace(/'/g, "''");
  return `'${safe}'!${range}`;
}
function normShopDomain(s){
  return String(s || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}
function safeEq(a,b){
  const A = Buffer.from(String(a||''), 'utf8');
  const B = Buffer.from(String(b||''), 'utf8');
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A,B); } catch { return false; }
}

/* ───────────── AUTH ───────────── */
export function verifyRequest(req){
  const url = new URL(req.url);
  const params = url.searchParams;
  const forwardSecret = process.env.FORWARD_SECRET || process.env.X_SEOBOSS_FORWARD_SECRET;
  const appSecret = process.env.SHOPIFY_APP_SECRET;

  // A) Forward-secret header
  const hdrSecret = req.headers.get('x-seoboss-forward-secret');
  if (forwardSecret && hdrSecret && safeEq(forwardSecret, hdrSecret)){
    return { ok:true, mode:'forward-secret' };
  }

  // B) Shopify App Proxy HMAC (?signature=...)
  const sig = params.get('signature');
  if (appSecret && sig){
    const paramsNoSig = new URLSearchParams(params);
    paramsNoSig.delete('signature');
    const ordered = Array.from(paramsNoSig.entries())
      .sort(([a],[b])=>a.localeCompare(b))
      .map(([k,v])=>`${k}=${v}`)
      .join('');
    const digest = crypto.createHmac('sha256', appSecret).update(ordered).digest('hex');
    const ok = safeEq(digest, sig);
    return { ok, mode:'app-proxy' };
  }

  // Dev fallback
  const devOk = !forwardSecret && !appSecret;
  return { ok: devOk, mode: devOk ? 'dev' : 'unauthorized' };
}

/* ───────────── Google Sheets client via Supabase-stored SA ───────────── */
let _cachedSA = null;

async function getServiceAccountFromSupabase() {
  if (_cachedSA) return _cachedSA;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });
  const { data, error } = await supabase
    .from('private_secrets') // server-only table; stores JSON values
    .select('value')
    .eq('id', 'google_sa')
    .single();

  if (error) throw new Error(`Supabase secrets fetch failed: ${error.message}`);
  if (!data || !data.value) throw new Error('Supabase secret google_sa not found');

  const val = (typeof data.value === 'string') ? JSON.parse(data.value) : data.value;
  if (!val.client_email || !val.private_key) throw new Error('google_sa missing client_email or private_key');
  _cachedSA = val;
  return _cachedSA;
}

export async function getSheetsClient() {
  const creds = await getServiceAccountFromSupabase();
  const jwt = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await jwt.authorize();
  return google.sheets({ version: 'v4', auth: jwt });
}

/* ───────────── Registry lookup (by shop_url OR client_id) ───────────── */
let _regCache = null;

export async function lookupClientSheetByShop({ sheets, shopDomain, clientId }){
  const registryId     = process.env.REGISTRY_SHEET_ID;
  const registryTab    = process.env.REGISTRY_SHEET_TAB || 'clients';
  const fallbackSheetId= process.env.VAULT_SHEET_ID || '';
  const fallbackTab    = process.env.VAULT_SHEET_TAB || 'Master Vault';

  if (!registryId){
    if (!fallbackSheetId) throw new Error('No registry configured (REGISTRY_SHEET_ID) and no fallback (VAULT_SHEET_ID).');
    return { sheetId: fallbackSheetId, tab: fallbackTab, _source:'fallback' };
  }

  const now = Date.now();
  if (!_regCache || (now - (_regCache.t||0)) > 60_000) {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: registryId,
      range: A1(registryTab, 'A1:Z5000'),
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    _regCache = { t: now, rows: (data.values || []) };
  }
  const rows = _regCache.rows;
  if (!rows.length) throw new Error(`Registry tab '${registryTab}' is empty`);

  const header = rows[0].map(h => (h||'').trim());
  const lower  = header.map(h => h.toLowerCase());
  const colIndex = (name) => lower.indexOf(name.toLowerCase());

  const iShop = colIndex('shop_url');
  const iCid  = colIndex('client_id');
  const iId   = (() => {
    const a = colIndex('vault_sheet_id');
    if (a >= 0) return a;
    const b = colIndex('sheet_id');
    if (b >= 0) return b;
    return colIndex('sheet_url');
  })();
  const iTab  = colIndex('vault_tab');

  if (iShop < 0) throw new Error(`Registry tab '${registryTab}' missing column 'shop_url'`);
  if (iId   < 0) throw new Error(`Registry tab '${registryTab}' needs one of: 'vault_sheet_id' | 'sheet_id' | 'sheet_url'`);

  const wantShop = normShopDomain(shopDomain);

  const match = rows.slice(1).find(r => {
    const shop = normShopDomain(r[iShop]);
    const cid  = iCid >= 0 ? String(r[iCid]||'').trim() : '';
    return (wantShop && shop === wantShop) || (!!clientId && cid === clientId);
  });

  if (!match) {
    if (fallbackSheetId) return { sheetId: fallbackSheetId, tab: fallbackTab, _source:'fallback-no-row' };
    throw new Error(`No registry row for shop '${wantShop}'`);
  }

  let sheetId = String(match[iId] || '').trim();
  if (sheetId.includes('/spreadsheets/d/')) {
    const m = sheetId.match(/\/spreadsheets\/d\/([^/]+)/i);
    sheetId = m ? m[1] : '';
  }
  if (!sheetId) throw new Error(`Registry row for '${wantShop}' has empty sheet id/url`);

  const tab = (iTab >= 0 ? String(match[iTab]||'').trim() : '') || fallbackTab;

  if (process.env.DEBUG_REGISTRY === '1') {
    console.log(JSON.stringify({ debug_registry_resolved: { sheetId, tab, shop: wantShop } }));
  }
  return { sheetId, tab, _source:'registry' };
}

/* ───────────── Request context + CORS ───────────── */
export function tenantFrom(req){
  const url = new URL(req.url);
  const hdrShop = req.headers.get('x-shop') || req.headers.get('x-shopify-shop-domain') || '';
  const qsShop  = url.searchParams.get('shop') || '';
  const shop    = normShopDomain(hdrShop || qsShop);

  const hdrClient = req.headers.get('x-client-id') || '';
  const qsClient  = url.searchParams.get('client_id') || '';
  const client_id = String(hdrClient || qsClient).trim();

  return { shop, client_id };
}

export function corsWrap(res){
  const corsHeaders = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'OPTIONS, GET, POST',
    'access-control-allow-headers': 'content-type, x-seoboss-forward-secret, x-shop, x-client-id'
  };

  // Response instance passed?
  if (res instanceof Response) {
    const headers = new Headers(res.headers);
    Object.entries(corsHeaders).forEach(([k,v]) => headers.set(k, v));
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers
    });
  }

  // Init-style object
  const headers = new Headers(res?.headers || {});
  Object.entries(corsHeaders).forEach(([k,v]) => headers.set(k, v));

  // For 204, body must be null/undefined
  const status = res?.status ?? 200;
  const body = status === 204 ? null : (res?.body ?? '');

  return new Response(body, { status, headers });
}
