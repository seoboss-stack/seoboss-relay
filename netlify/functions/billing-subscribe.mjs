import { sb, json, CORS } from './_lib/_supabase.mjs';

// Accept whatever the UI sends, normalize to an internal key
const PLAN_ALIASES = {
  trial: 'trial',
  starter: 'starter',
  basic: 'starter',
  pro: 'pro',
  growth: 'pro',
  scale: 'scale',
  boss: 'scale',         // <- you can flip this later to 'boss' if you change the slug
};

// Default caps per internal key
const PLAN_DEFAULTS = {
  trial:   { articles: 10, keyword_basic: 20, keyword_buyer: 10, keyword_questions: 10, keyword_ai: 0 },
  starter: { articles: 30, keyword_basic: 30, keyword_buyer: 20, keyword_questions: 20, keyword_ai: 0 },
  pro:     { articles: 60, keyword_basic: 60, keyword_buyer: 40, keyword_questions: 40, keyword_ai: 10 },
  scale:   { articles: 120, keyword_basic: 120, keyword_buyer: 80, keyword_questions: 80, keyword_ai: 30 },
};

function normalizePlan(p) {
  const key = (p || 'starter').toLowerCase().trim();
  return PLAN_ALIASES[key] || 'starter';
}

function capsFor(planKey) {
  const p = PLAN_DEFAULTS[planKey] || PLAN_DEFAULTS.starter;
  return {
    monthly_cap: p.articles, // legacy/global, keep aligned with article cap
    caps_json: {
      article: p.articles,
      keyword_basic: p.keyword_basic,
      keyword_buyer: p.keyword_buyer,
      keyword_questions: p.keyword_questions,
      keyword_ai: p.keyword_ai,
    }
  };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status:204, headers: CORS });
  if (req.method !== 'POST')    return json({ error:'POST only' }, 405);

  try {
    const body = await req.json().catch(()=> ({}));
    const u = new URL(req.url);
    const shop = (u.searchParams.get('shop') || body.shop || '').toLowerCase().trim();
    const requested = (body.plan || 'starter').toLowerCase().trim();
    const planKey = normalizePlan(requested);
    const trialDays = Number.isFinite(+body.trial_days) ? Math.max(0, +body.trial_days) : 0;
    if (!shop) return json({ error:'Missing shop' }, 400);

    const supa = sb();

    if (planKey === 'trial') {
      // Store as starter while trial is active (matches your old behavior)
      const { monthly_cap, caps_json } = capsFor('starter');
      const until = new Date(Date.now() + (trialDays || 3) * 86400 * 1000);

      await supa.from('billing_plans').upsert({
        shop,
        plan: 'starter',
        active: true,
        monthly_cap,
        caps_json,
        trial_started_at: new Date().toISOString(),
        trial_expires_at: until.toISOString(),
      });

      return json({ ok:true, confirmation_url: `/apps/engine/thanks?plan=trial&trial_until=${encodeURIComponent(until.toISOString())}` }, 200);
    }

    // Regular paid plan
    const { monthly_cap, caps_json } = capsFor(planKey);
    await supa.from('billing_plans').upsert({
      shop,
      plan: planKey,           // <- change this later to 'boss' if you rename the slug
      active: true,
      monthly_cap,
      caps_json,
      trial_started_at: null,
      trial_expires_at: null,
    });

    return json({ ok:true, confirmation_url: `/apps/engine/thanks?plan=${encodeURIComponent(planKey)}` }, 200);
  } catch (e) {
    return json({ error:'internal', detail:String(e) }, 500);
  }
};
