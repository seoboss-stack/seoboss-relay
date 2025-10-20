import { sb, json, CORS } from './_lib/_supabase.mjs';

function planPresets(plan){
  // 🔧 Edit these numbers any time
  const presets = {
    starter: { monthly_cap: 30,  caps_json: { article:30,  keyword_basic:30,  keyword_ai:0 } },
    pro:     { monthly_cap: 60,  caps_json: { article:60,  keyword_basic:60,  keyword_ai:0 } },
    scale:   { monthly_cap: 120, caps_json: { article:120, keyword_basic:120, keyword_ai:20 } },
  };
  return presets[plan] || presets.starter;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status:204, headers: CORS });
  if (req.method !== 'POST')    return json({ error:'POST only' }, 405);

  try {
    const body = await req.json().catch(()=> ({}));
    const u = new URL(req.url);
    const shop  = (u.searchParams.get('shop') || body.shop || '').toLowerCase();
    let plan    = (body.plan || 'starter').toLowerCase();
    const trialDays = Number.isFinite(+body.trial_days) ? Math.max(0, +body.trial_days) : 0;
    if (!shop) return json({ error:'Missing shop' }, 400);

    const supa = sb();
    let trial_expires_at = null;

    if (plan === 'trial') {
      // 👉 Pick ONE: safer (0 AI) or teaser (2 AI)
      const trialCaps = { article:3, keyword_basic:30, keyword_ai:0 };
      // const trialCaps = { article:3, keyword_basic:30, keyword_ai:2 };

      const d = new Date();
      d.setDate(d.getDate() + (trialDays || 3));
      trial_expires_at = d.toISOString();

      await supa.from('billing_plans').upsert({
        shop,
        plan: 'starter',              // store as starter while in trial
        active: true,
        monthly_cap: trialCaps.article, // UI badge uses article cap
        caps_json: trialCaps,
        trial_expires_at
      });
    } else {
      const { monthly_cap, caps_json } = planPresets(plan);
      await supa.from('billing_plans').upsert({
        shop, plan, active: true, monthly_cap, caps_json
      });
    }

    const confirmation_url =
      `/apps/engine/thanks?plan=${encodeURIComponent(plan)}${trial_expires_at ? `&trial_until=${encodeURIComponent(trial_expires_at)}` : ''}`;

    return json({ ok:true, confirmation_url }, 200);
  } catch (e) {
    return json({ error:'internal', detail:String(e) }, 500);
  }
};
