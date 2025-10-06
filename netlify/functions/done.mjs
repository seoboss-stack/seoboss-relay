import { sb, json } from './_supabase.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const { searchParams } = new URL(req.url);
  const token = searchParams.get('token');
  if (!token || token !== process.env.FORWARD_SECRET) return json({ error: 'Unauthorized' }, 401);

  const body = await req.json().catch(() => ({}));
  const { jobId, status = 'done', result = null, error_text = null } = body;
  if (!jobId) return json({ error: 'Missing jobId' }, 400);

  const supa = sb();
  const { error } = await supa.from('jobs')
    .update({
      status: error_text ? 'error' : status,
      result_json: result,
      error_text,
      updated_at: new Date().toISOString()
    })
    .eq('job_id', jobId);
  if (error) return json({ error: 'db update failed', detail: error.message }, 500);

  return new Response(null, { status: 204 });
}
