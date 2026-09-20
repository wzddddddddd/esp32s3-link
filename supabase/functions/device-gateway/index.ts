import { createClient } from 'npm:@supabase/supabase-js@2';

// Custom device credential replaces user JWT authentication for this one endpoint.
// Never return service keys, raw SQL errors, or other devices' data.
Deno.serve(async request => {
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (request.method !== 'POST') return respond({ error: 'METHOD_NOT_ALLOWED' }, 405);
  const id = request.headers.get('x-device-id') || '';
  const token = request.headers.get('x-device-token') || '';
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f]{64}$/i.test(token)) return respond({ error: 'UNAUTHORIZED' }, 401);
  try {
    const text = await request.text();
    if (text.length > 65536) return respond({ error: 'PAYLOAD_TOO_LARGE' }, 413);
    const input = JSON.parse(text);
    if (!input || !['heartbeat', 'claim', 'progress'].includes(input.action) || (input.payload && (typeof input.payload !== 'object' || Array.isArray(input.payload)))) return respond({ error: 'INVALID_REQUEST' }, 400);
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
    const result = await client.rpc('link_device_request', { p_device_id: id, p_token: token, p_action: input.action, p_payload: input.payload || {} });
    if (result.error) return respond({ error: result.error.code === '28000' ? 'UNAUTHORIZED' : 'REQUEST_REJECTED' }, result.error.code === '28000' ? 401 : 409);
    if (result.data?.task) {
      const { storage_path, ...task } = result.data.task;
      const signed = await client.storage.from('link-resources').createSignedUrl(storage_path, 900);
      if (signed.error) return respond({ error: 'DOWNLOAD_URL_UNAVAILABLE', retryable: true }, 503);
      return respond({ task: { ...task, download_url: signed.data.signedUrl, url_expires_in: 900 } });
    }
    return respond(result.data);
  } catch { return respond({ error: 'INVALID_REQUEST' }, 400); }
});
