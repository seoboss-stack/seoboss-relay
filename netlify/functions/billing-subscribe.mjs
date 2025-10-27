// netlify/functions/billing-subscribe.mjs
import { sb, json, CORS } from './_lib/_supabase.mjs';
import { errlog } from './_lib/_errlog.mjs';

// Accept whatever the UI sends, normalize to an internal key
const PLAN_ALIASES = {
  trial: 'trial',
  starter: 'starter',
  basic: 'starter',
  pro: 'pro',
  growth: 'pro',
  scale: 'scale',
  boss: 'scale',
};

const PLAN_DEFAULTS = {
  trial:   { articles: 10,  keyword_basic: 20,  keyword_buyer: 10,  keyword_questions: 10,  keyword_ai: 0 },
  starter: { articles: 30,  keyword_basic: 30,  keyword_buyer: 20,  keyword_questions: 20,  keyword_ai: 0 },
  pro:     { articles: 60,  keyword_basic: 60,  keyword_buyer: 40,  keyword_questions: 40,  keyword_ai: 10 },
  scale:   { articles: 120, keyword_basic: 120, keyword_buyer: 80,  keyword_questions: 80,  keyword_ai: 30 },
};

function normalizePlan(p) {
  const key = (p || 'starter').toLowerCase().trim();
  return PLAN_ALIASES[key] || 'starter';
}

function capsFor(planKey) {
  const p = PLAN_DEFAULTS[planKey] || PLAN_DEFAULTS.starter;
  return {
    monthly_cap: p.articles, // legacy/global, align with article cap
    caps_json: {
      article: p.articles,
      keyword_basic: p.keyword_basic,
      keyword_buyer: p.keyword_buyer,
      keyword_questions: p.keyword_questions,
      keyword_ai: p.keyword_ai,
    },
  };
}

function normShop(s){
  return String(s)
    .trim().toLowerCase()
    .replace(/^https?:\/\//,'')
    .replace(/[?#].*$/,'')
    .replace(/\/.*/,'')
    .replace(/:\d+$/,'')
    .replace(/\.shopify\.com$/i, '.myshopify.com');
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'POST only' }, 405);

  const request_id = req.headers.get('x-request-id') || '';

  let body = {};
  try {
    body = await req.json().catch(() => ({}));

    const u = new URL(req.url);
    const rawShop   = u.searchParams.get('shop') || body.shop || '';
    const shop      = normShop(rawShop);
    const requested = (body.plan || 'starter').toLowerCase().trim();
    const planKey   = normalizePlan(requested);
    const trialDays = Number.isFinite(+body.trial_days) ? Math.max(0, +body.trial_days) : 0;

    if (!shop) return json({ error: 'Missing shop' }, 400);

    const supa = sb();

    // ⛑ SAFETY GUARD — prevent seed plans from overwriting paid/active plans
    const paidPlans = new Set(['pro','scale']);
    const seedPlans = new Set(['trial','starter']);

    const { data: existing, error: lookupErr } =
      await supa.from('billing_plans')
        .select('shop, plan, active, monthly_cap, caps_json, trial_expires_at, created_at, updated_at, bonus_cap')
        .eq('shop', shop)
        .maybeSingle();

    if (lookupErr) {
      await errlog({
        shop, route: '/billing-subscribe', status: 500,
        message: 'Plan lookup failed',
        detail: lookupErr.message, request_id, code: 'E_DB_READ'
      });
      return json({ error: 'plan_lookup_failed', detail: lookupErr.message }, 500);
    }

    if (existing) {
      const currentPlan = (existing.plan || '').toLowerCase();
      const isPaidActive = paidPlans.has(currentPlan) && !!existing.active;
      const incomingIsSeed = seedPlans.has(planKey);

      // If already paid & active, ignore trial/starter writes
      if (isPaidActive && incomingIsSeed) {
        return json({ ok: true, row: existing, skipped: 'already_paid' }, 200);
      }

      // If we’re idempotently setting the same paid plan again, just return existing
      if (paidPlans.has(planKey) && currentPlan === planKey && !!existing.active) {
        return json({ ok: true, row: existing, skipped: 'already_set' }, 200);
      }
    }
    // ⛑ END GUARD

    if (planKey === 'trial') {
      // Store as starter while trial is active
      const { monthly_cap, caps_json } = capsFor('starter');
      const until = new Date(Date.now() + (trialDays || 3) * 86400 * 1000);

      const payload = {
        shop,
        plan: 'starter',
        active: true,
        monthly_cap,
        caps_json,
        trial_started_at: new Date().toISOString(),
        trial_expires_at: until.toISOString(),
      };

      const { data, error } = await supa
        .from('billing_plans')
        .upsert(payload, { onConflict: 'shop' })
        .select()
        .maybeSingle();

      if (error) {
        await errlog({
          shop,
          route: '/billing-subscribe',
          status: 500,
          message: 'Upsert failed (trial)',
          detail: error.message,
          request_id,
          code: 'E_DB_WRITE',
        });
        return json({ error: 'db_upsert_failed', detail: error.message }, 500);
      }

      return json({
        ok: true,
        row: data,
        confirmation_url: `/apps/engine/thanks?plan=trial&trial_until=${encodeURIComponent(until.toISOString())}`,
      }, 200);
    }

    // Regular paid plan
    const { monthly_cap, caps_json } = capsFor(planKey);

    const payload = {
      shop,
      plan: planKey,
      active: true,
      monthly_cap,
      caps_json,
      trial_started_at: null,
      trial_expires_at: null,
    };

    const { data, error } = await supa
      .from('billing_plans')
      .upsert(payload, { onConflict: 'shop' })
      .select()
      .maybeSingle();

    if (error) {
      await errlog({
        shop,
        route: '/billing-subscribe',
        status: 500,
        message: 'Upsert failed (paid)',
        detail: error.message,
        request_id,
        code: 'E_DB_WRITE',
      });
      return json({ error: 'db_upsert_failed', detail: error.message }, 500);
    }

    return json({
      ok: true,
      row: data,
      confirmation_url: `/apps/engine/thanks?plan=${encodeURIComponent(planKey)}`,
    }, 200);

  } catch (e) {
    await errlog({
      shop: body?.shop || '',
      route: '/billing-subscribe',
      status: 500,
      message: 'Failed to update billing plan',
      detail: e.stack || String(e),
      request_id,
      code: 'E_EXCEPTION',
    });
    return json({ error: 'internal', detail: String(e) }, 500);
  }
};
