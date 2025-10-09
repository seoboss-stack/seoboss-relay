// shared.mjs — dual-auth (App Proxy HMAC OR Forward Secret) + registry lookup keyed by shop_url
import crypto from 'crypto';
import { google } from 'googleapis';

export function verifyRequest(req){
  const url = new URL(req.url);
  const params = url.searchParams;
  const forwardSecret = process.env.FORWARD_SECRET || process.env.X_SEOBOSS_FORWARD_SECRET;
  const appSecret = process.env.SHOPIFY_APP_SECRET;

  // Mode A: Forward Secret header (good when calling via n8n or Netlify proxy)
  const hdrSecret = req.headers.get('x-seoboss-forward-secret');
  if (forwardSecret && hdrSecret && safeEq(forwardSecret, hdrSecret)){
    return { ok:true, mode:'forward-secret' };
  }

  // Mode B: Shopify App Proxy HMAC
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

  // Dev fallback: allow if neither secret is set (local dev)
  const devOk = !forwardSecret && !appSecret;
  return { ok: devOk, mode: devOk ? 'dev' : 'unauthorized' };
}

function safeEq(a,b){
  try{
    return crypto.timingSafeEqual(Buffer.from(String(a), 'utf8'), Buffer.from(String(b), 'utf8'));
  }catch{ return false; }
}

export async function getSheetsClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  const creds = JSON.parse(raw);
  const jwt = new google.auth.JWT(
    creds.client_email, null, creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await jwt.authorize();
  return google.sheets({ version: 'v4', auth: jwt });
}

export async function lookupClientSheetByShop({ sheets, shopDomain, clientId }){
  // Registry env
  const registryId = process.env.REGISTRY_SHEET_ID;
  const registryTab = process.env.REGISTRY_SHEET_TAB || 'clients';
  const fallbackSheetId = process.env.VAULT_SHEET_ID;
  const fallbackTab = process.env.VAULT_SHEET_TAB || 'content_vault';

  if (!registryId){
    return { sheetId: fallbackSheetId, tab: fallbackTab };
  }
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: registryId,
    range: `${registryTab}!A1:Z5000`
  });
  const rows = data.values || [];
  const header = rows[0] || [];
  const idx = (name)=> header.findIndex(h => (h||'').trim() === name);
  const iShop = idx('shop_url');
  const iClient = idx('client_id');
  const iSheet = (idx('vault_sheet_id')>=0? idx('vault_sheet_id'): idx('sheet_id'));
  const iTab = idx('vault_tab');

  // Prefer shop_url strict match (no https)
  const norm = (s)=> String(s||'').replace(/^https?:\/\//,'').trim().toLowerCase();
  const match = rows.slice(1).find(r => {
    const shop = norm(r[iShop]);
    const cid = (r[iClient]||'').trim();
    return (shop && shop === norm(shopDomain)) || (clientId && cid === clientId);
  });

  if (!match) return { sheetId: fallbackSheetId, tab: fallbackTab };

  const sheetId = (match[iSheet]||'').trim() || fallbackSheetId;
  const tab = (match[iTab]||'').trim() || fallbackTab;
  return { sheetId, tab };
}

export function tenantFrom(req){
  const shop = req.headers.get('x-shop') 
           || req.headers.get('x-shopify-shop-domain')
           || new URL(req.url).searchParams.get('shop') 
           || '';
  const client_id = new URL(req.url).searchParams.get('client_id') || '';
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
