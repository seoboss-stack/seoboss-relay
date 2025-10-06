import { sb, json } from './_supabase.mjs';

export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405);

  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get('jobId');
  if (!jobId) return json({ error: 'Missing jobId' }, 400);

  const supa = sb();
  const { data, error } = await supa.from('jobs').select('*').eq('job_id', jobId).single();
  if (error || !data) return json({ error: 'Not found' }, 404);

  return json({
    jobId,
    status: data.status,
    result: data.result_json ?? null,
    error: data.error_text ?? null,
    updatedAt: data.updated_at
  });
}
