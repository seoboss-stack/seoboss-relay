// shared.mjs — dual-auth (App Proxy HMAC OR Forward Secret) + registry lookup keyed by shop_url
import crypto from 'crypto';
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js'; // <— NEW

/* ───────────────── AUTH ───────────────── */
export function verifyRequest(req){
  const url = new URL(req.url);
  const params = url.searchParams;
  const forwardSecret = process.env.FORWARD_SECRET || process.env.X_SEOBOSS_FORWARD_SECRET;
  const appSecret = process.env.SHOPIFY_APP_SECRET;

  // A) Forward secret header
  const hdrSecret = req.headers.get('x-seoboss-forward-secret');
  if (forwardSecret && hdrSecret && safeEq(forwardSecret, hdrSecret)){
    return { ok:true, mode:'forward-secret' };
  }

  // B) Shopify App Proxy HMAC (?signature=...)
  if (appSecret && params.get('signature')){
    const sig = params.get('signature');
    params.delete('signature');
    const ordered = Array.from(params.entries())
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

function safeEq(a,b){
  try{
    return crypto.timingSafeEqual(Buffer.from(String(a), 'utf8'), Buffer.from(String(b), 'utf8'));
  }catch{ return false; }
}

/* ───────────── GOOGLE SHEETS CLIENT via Supabase secret ───────────── */
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
    .from('private_secrets')
    .select('value')
    .eq('id', 'google_sa')
    .single();
  if (error) throw new Error(`Supabase secrets fetch failed: ${error.message}`);
  if (!data || !data.value) throw new Error('Supabase secret google_sa not found');
  _cachedSA = data.value; // { client_email, private_key, ... }
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

/* ───────────── REGISTRY LOOKUP (by shop_url) ─────────────
 * Registry columns (case-insensitive):
 *   - shop_url
 *   - one of: vault_sheet_id | sheet_id | sheet_url
 * Optional:
 *   - vault_tab (we default to env VAULT_SHEET_TAB or 'Master Vault')
 */
export async function lookupClientSheetByShop({ sheets, shopDomain, clientId }){
  const registryId = process.env.REGISTRY_SHEET_ID;
  const registryTab = process.env.REGISTRY_SHEET_TAB || 'clients';
  const fallbackSheetId = process.env.VAULT_SHEET_ID || '';
  const fallbackTab = process.env.VAULT_SHEET_TAB || 'Master Vault';

  if (!registryId){
    if (!fallbackSheetId) throw new Error('No registry configured (REGISTRY_SHEET_ID) and no fallback (VAULT_SHEET_ID).');
    return { sheetId: fallbackSheetId, tab: fallbackTab, _source:'fallback' };
  }

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: registryId,
    range: `${registryTab}!A1:Z5000`
  });
  const rows = data.values || [];
  if (!rows.length) throw new Error(`Registry tab '${registryTab}' is empty`);

  const header = rows[0].map(h => (h||'').trim());
  const lower = header.map(h => h.toLowerCase());
  const colIndex = (name) => lower.indexOf(name.toLowerCase());

  const iShop = colIndex('shop_url');
  const iCid  = colIndex('client_id');
  const iId   = (() => {
    const a = colIndex('vault_sheet_id');
    if (a >= 0) return a;
    const b = colIndex('sheet_id');
    if (b >= 0) return b;
    return colIndex('sheet_url'); // accept full URL
  })();
  const iTab  = colIndex('vault_tab');

  if (iShop < 0) throw new Error(`Registry tab '${registryTab}' missing column 'shop_url'`);
  if (iId   < 0) throw new Error(`Registry tab '${registryTab}' needs one of: 'vault_sheet_id' | 'sheet_id' | 'sheet_url'`);

  const normShop = (s)=> String(s||'').replace(/^https?:\/\//,'').trim().toLowerCase();
  const wantShop = normShop(shopDomain);

  const match = rows.slice(1).find(r => {
    const shop = normShop(r[iShop]);
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
    console.log(JSON.stringify({ debug_registry_resolved: { sheetId, tab } }));
  }
  return { sheetId, tab, _source:'registry' };
}

/* ───────────── REQUEST CONTEXT HELPERS ───────────── */
export function tenantFrom(req){
  const url = new URL(req.url);
  const shop = req.headers.get('x-shop')
           || req.headers.get('x-shopify-shop-domain')
           || url.searchParams.get('shop')
           || '';
  const client_id = url.searchParams.get('client_id') || '';
  return { shop, client_id };
}

export function corsWrap(res){
  const corsHeaders = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'OPTIONS, GET, POST',
    'access-control-allow-headers': 'content-type, x-seoboss-forward-secret, x-shop'
  };
  const headers = new Headers(res.headers || {});
  Object.entries(corsHeaders).forEach(([k,v])=> headers.set(k,v));
  return new Response(res.body, { ...res, headers });
}
