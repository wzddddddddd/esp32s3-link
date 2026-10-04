import { createClient } from 'npm:@supabase/supabase-js@2';
import { attachDeviceSocket, executeRequest, parseRequest } from './protocol.ts';
import { inspectMainFirmware } from '../_shared/firmware.ts';

// Device credentials are accepted in headers only, including the WSS upgrade.
// Do not put device tokens or the service key in browser code or URL queries.
Deno.serve(async request => {
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  const upgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
  if (request.method !== 'POST' && !(request.method === 'GET' && upgrade)) return respond({ error: 'METHOD_NOT_ALLOWED' }, 405);
  const id = request.headers.get('x-device-id') || '', token = request.headers.get('x-device-token') || '';
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f]{64}$/i.test(token)) return respond({ error: 'UNAUTHORIZED' }, 401);
  const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    if (upgrade) {
      // Validate before accepting the socket. This does not claim a command.
      const auth = await client.rpc('link_device_session', { p_device_id: id, p_token: token });
      if (auth.error || auth.data !== true) return respond({ error: 'UNAUTHORIZED' }, 401);
      const { socket, response } = Deno.upgradeWebSocket(request);
      const session = crypto.randomUUID();
      const presence = async (event: 'open' | 'renew' | 'close') => {
        const result = await client.rpc('link_device_presence', { p_device_id: id, p_token: token, p_event: event, p_session: session });
        if (result.error || (event !== 'close' && result.data !== true)) throw new Error('PRESENCE_UNAVAILABLE');
      };
      attachDeviceSocket(socket, input => executeRequest(client, id, token, input, inspectMainFirmware), wake => {
        const channel = client.channel(`device-wake-${id}-${crypto.randomUUID()}`)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'link_commands', filter: `device_id=eq.${id}` }, wake)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'link_tasks', filter: `device_id=eq.${id}` }, wake)
          .subscribe(status => { if (status === 'SUBSCRIBED') wake(); });
        return () => { void client.removeChannel(channel); };
      }, presence);
      return response;
    }
    const input = parseRequest(await request.text());
    const presence = await client.rpc('link_device_presence', { p_device_id: id, p_token: token, p_event: 'http', p_session: null });
    if (presence.error) return respond({ error: 'UNAUTHORIZED' }, 401);
    const reply = await executeRequest(client, id, token, input, inspectMainFirmware);
    return respond(reply.body, reply.status);
  } catch (e) {
    const large = e instanceof Error && e.message === 'PAYLOAD_TOO_LARGE';
    return respond({ error: large ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST' }, large ? 413 : 400);
  }
});
