export interface GatewayReply { status: number; body: unknown }
export interface GatewayRequest { action: string; payload?: Record<string, unknown> }
const actions = new Set(['heartbeat', 'claim', 'progress', 'command_claim', 'command_progress', 'command_result']);
export function parseRequest(text: string): GatewayRequest {
  if (new TextEncoder().encode(text).length > 65536) throw new Error('PAYLOAD_TOO_LARGE');
  const input = JSON.parse(text);
  if (!input || !actions.has(input.action) || (input.payload !== undefined &&
      (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)))) throw new Error('INVALID_REQUEST');
  return { action: input.action, payload: input.payload };
}
// The injected client uses the server's service key. Every business RPC still
// authenticates the device token and checks ownership; transport is irrelevant.
export async function executeRequest(client: any, id: string, token: string, input: GatewayRequest): Promise<GatewayReply> {
  const commands = input.action.startsWith('command_');
  const result = await client.rpc(commands ? 'link_device_command' : 'link_device_request', {
    p_device_id: id, p_token: token, p_action: input.action, p_payload: input.payload || {},
  });
  if (result.error) return { status: result.error.code === '28000' ? 401 : 409,
    body: { error: result.error.code === '28000' ? 'UNAUTHORIZED' : 'REQUEST_REJECTED' } };
  if (result.data?.command) {
    const { download_path, upload_path, ...command } = result.data.command;
    if (command.op === 'put' || command.op === 'get') {
      const store = client.storage.from('link-resources');
      const signed = command.op === 'put' ? await store.createSignedUrl(download_path, 900)
        : await store.createSignedUploadUrl(upload_path, { upsert: true });
      if (signed.error) return { status: 503, body: { error: command.op === 'put' ? 'DOWNLOAD_URL_UNAVAILABLE' : 'UPLOAD_URL_UNAVAILABLE', retryable: true } };
      return { status: 200, body: { command: { ...command, [command.op === 'put' ? 'download_url' : 'upload_url']: signed.data.signedUrl } } };
    }
    return { status: 200, body: { command } };
  }
  if (result.data?.task) {
    const { storage_path, ...task } = result.data.task;
    const signed = await client.storage.from('link-resources').createSignedUrl(storage_path, 900);
    if (signed.error) return { status: 503, body: { error: 'DOWNLOAD_URL_UNAVAILABLE', retryable: true } };
    return { status: 200, body: { task: { ...task, download_url: signed.data.signedUrl, url_expires_in: 900 } } };
  }
  return { status: 200, body: result.data };
}

interface DeviceSocket {
  readyState: number;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
}
export function attachDeviceSocket(socket: DeviceSocket,
    execute: (input: GatewayRequest) => Promise<GatewayReply>,
    subscribe: (wake: () => void) => () => void) {
  let disposed = false, queued = 0, chain = Promise.resolve();
  let unsubscribe = () => {};
  let safety: ReturnType<typeof setInterval> | undefined;
  let rotation: ReturnType<typeof setTimeout> | undefined;
  const send = (body: unknown) => { if (!disposed && socket.readyState === 1) socket.send(JSON.stringify(body)); };
  const wake = () => send({ type: 'wake' });
  const cleanup = () => {
    if (disposed) return;
    disposed = true; unsubscribe(); clearInterval(safety); clearTimeout(rotation);
  };
  socket.onopen = () => {
    if (disposed) return;
    unsubscribe = subscribe(wake);
    send({ type: 'ready' }); wake();
    // Recover missed database notifications. Device requests and replies use
    // this same socket; no repeated HTTP/TLS handshake is involved.
    safety = setInterval(wake, 3000);
    // Stay within the shortest hosted Edge Function lifetime. Reconnection
    // claims any pending command, so updates during rotation are not lost.
    rotation = setTimeout(() => { cleanup(); socket.close(1000, 'session rotation'); }, 110000);
  };
  socket.onmessage = event => {
    if (disposed) return;
    let input: GatewayRequest, id: number;
    try {
      if (typeof event.data !== 'string') throw new Error('INVALID_REQUEST');
      input = parseRequest(event.data);
      id = JSON.parse(event.data).id;
      if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw new Error('INVALID_REQUEST');
    } catch { cleanup(); socket.close(1008, 'invalid request'); return; }
    if (queued >= 4) { send({ id, status: 429, body: { error: 'BUSY' } }); return; }
    queued++;
    chain = chain.then(async () => {
      if (disposed) return;
      try {
        const reply = await execute(input);
        send({ id, ...reply });
        if (reply.status === 401) { cleanup(); socket.close(1008, 'unauthorized'); }
      } catch { send({ id, status: 503, body: { error: 'UNAVAILABLE', retryable: true } }); }
      finally { queued--; }
    });
  };
  socket.onclose = cleanup;
  socket.onerror = cleanup;
  return cleanup;
}
