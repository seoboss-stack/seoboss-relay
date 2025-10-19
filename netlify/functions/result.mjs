// netlify/functions/result.mjs
import { sb, json, CORS } from './_lib/_supabase.mjs';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405);

  try {
    const { searchParams } = new URL(req.url);
    const jobId = searchParams.get('jobId');
    // prefer App Proxy-supplied shop, fallback to header
    const shop =
      searchParams.get('shop') ||
      req.headers.get('x-shopify-shop-domain') ||
      '';

    if (!jobId || !shop) {
      return json({ error: 'Missing jobId or shop' }, 400);
    }

    const supa = sb();
    const { data, error } = await supa
      .from('jobs')
      .select('*')
      .eq('job_id', jobId)
      .eq('shop', shop.toLowerCase())
      .single();

    if (error || !data) return json({ error: 'Not found' }, 404);

    return json({
      jobId,
      shop,
      status: data.status,
      result: data.result_json ?? null,
      error: data.error_text ?? null,
      updatedAt: data.updated_at,
    });
  } catch (e) {
    console.error('RESULT error:', e);
    return json({ error: 'internal', detail: String(e) }, 500);
  }
};
