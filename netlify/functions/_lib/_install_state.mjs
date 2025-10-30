import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

export function normShop(s=''){
  return String(s).trim().toLowerCase()
    .replace(/^https?:\/\//,'').replace(/[?#].*$/,'')
    .replace(/\/.*/,'')
    .replace(/\.shopify\.com$/i, '.myshopify.com');
}

/**
 * Returns true if this shop already has a vaulted token (i.e. installed).
 * Uses public.encrypted_shop_tokens as your source of truth.
 */
export async function hasInstalledShop(rawShop){
  if (!SUPABASE_URL || !SERVICE_KEY) return false;
  const shop = normShop(rawShop);
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false }});
  const { data, error } = await supa
    .from('encrypted_shop_tokens')
    .select('shop, client_id')
    .eq('shop', shop)
    .limit(1)
    .maybeSingle();

  if (error) return false;
  return !!data;
}
