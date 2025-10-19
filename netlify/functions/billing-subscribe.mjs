import { sb, json, CORS } from './_lib/_supabase.mjs';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status:204, headers: CORS });
  if (req.method !== 'POST')    return json({ error:'POST only' }, 405);

  try {
    const body = await req.json().catch(()=> ({}));
    const u = new URL(req.url);
    const shop = (u.searchParams.get('shop') || body.shop || '').toLowerCase();
    const plan = (body.plan || 'starter').toLowerCase();
    if (!shop) return json({ error:'Missing shop' }, 400);

    const monthly_cap = plan === 'pro' ? 100 : plan === 'scale' ? 300 : 25;
    const caps_json = {}; // v1 we only count articles; fill later for keywords

    const supa = sb();
    await supa.from('billing_plans').upsert({ shop, plan, active: true, monthly_cap, caps_json });

    // v1 stub (later swap to Shopify subscription confirmation_url)
    const confirmation_url = `/apps/engine/thanks?plan=${encodeURIComponent(plan)}`;
    return json({ ok:true, confirmation_url }, 200);
  } catch (e) {
    return json({ error:'internal', detail:String(e) }, 500);
  }
};
