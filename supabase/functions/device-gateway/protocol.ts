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
export async function executeRequest(client: any, id: string, token: string, input: GatewayRequest,
    verifyFirmware?: (bytes: Uint8Array) => Promise<{size: number; sha256: string}>): Promise<GatewayReply> {
  const commands = input.action.startsWith('command_');
  const result = await client.rpc(commands ? 'link_device_command' : 'link_device_request', {
    p_device_id: id, p_token: token, p_action: input.action, p_payload: input.payload || {},
  });
  if (result.error) return { status: result.error.code === '28000' ? 401 : 409,
    body: { error: result.error.code === '28000' ? 'UNAUTHORIZED' : 'REQUEST_REJECTED' } };
  if (result.data?.command) {
    const { download_path, upload_path, ...command } = result.data.command;
    if (command.op === 'put' || command.op === 'get' || command.op === 'ota.install') {
      const store = client.storage.from('link-resources');
      if (command.op === 'ota.install') {
        const object = await store.download(download_path);
        if (object.error) return { status: 503, body: { error: 'OTA_DOWNLOAD_VALIDATION_UNAVAILABLE', retryable: true } };
        try {
          if (!verifyFirmware || command.target_role !== 'main' || !Number.isSafeInteger(command.size)
              || command.size < 288 || command.size > 4194304 || !/^[0-9a-f]{64}$/.test(command.sha256)) throw new Error('Invalid OTA metadata');
          if (!object.data || object.data.size !== command.size) throw new Error('OTA storage size mismatch');
          const firmware = await verifyFirmware(new Uint8Array(await object.data.arrayBuffer()));
          if (firmware.size !== command.size || firmware.sha256 !== command.sha256) throw new Error('OTA storage SHA256 mismatch');
        } catch {
          await client.rpc('link_device_command', { p_device_id: id, p_token: token, p_action: 'command_result',
            p_payload: { id: command.id, status: 'failed', error: 'OTA_FIRMWARE_INVALID: main ESP32-S3 image/size/SHA256 verification failed' } });
          return { status: 200, body: { command: null, error: 'OTA_FIRMWARE_INVALID' } };
        }
      }
      const download = command.op !== 'get';
      const signed = download ? await store.createSignedUrl(download_path, 900)
        : await store.createSignedUploadUrl(upload_path, { upsert: true });
      if (signed.error) return { status: 503, body: { error: download ? 'DOWNLOAD_URL_UNAVAILABLE' : 'UPLOAD_URL_UNAVAILABLE', retryable: true } };
      return { status: 200, body: { command: { ...command, [download ? 'download_url' : 'upload_url']: signed.data.signedUrl } } };
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
    subscribe: (wake: () => void) => () => void,
    presence?: (event: 'open' | 'renew' | 'close') => Promise<void>) {
  let disposed = false, queued = 0, chain = Promise.resolve();
  let unsubscribe = () => {};
  let safety: ReturnType<typeof setInterval> | undefined;
  let rotation: ReturnType<typeof setTimeout> | undefined;
  let renewing = false;
  const send = (body: unknown) => { if (!disposed && socket.readyState === 1) socket.send(JSON.stringify(body)); };
  const wake = () => send({ type: 'wake' });
  const cleanup = () => {
    if (disposed) return;
    disposed = true; unsubscribe(); clearInterval(safety); clearTimeout(rotation);
    if (presence) void presence('close').catch(() => {});
  };
  const opened = () => {
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
  socket.onopen = () => {
    if (!presence) { opened(); return; }
    void presence('open').then(() => {
      if (disposed) { void presence('close').catch(() => {}); return; }
      opened();
    }).catch(() => { cleanup(); socket.close(1011, 'presence unavailable'); });
  };
  socket.onmessage = event => {
    if (disposed) return;
    let input: GatewayRequest, id: number;
    try {
      if (typeof event.data !== 'string') throw new Error('INVALID_REQUEST');
      if (event.data.length > 65536) throw new Error('PAYLOAD_TOO_LARGE');
      const raw = JSON.parse(event.data);
      if (raw?.type === 'presence' && presence) {
        if (!renewing) {
          renewing = true;
          void presence('renew').catch(() => { cleanup(); socket.close(1011, 'presence unavailable'); }).finally(() => { renewing = false; });
        }
        return;
      }
      input = parseRequest(event.data);
      id = JSON.parse(event.data).id;
      if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw new Error('INVALID_REQUEST');
    } catch { cleanup(); socket.close(1008, 'invalid request'); return; }
    if (queued >= 4) { send({ id, status: 429, body: { error: 'BUSY' } }); return; }
    queued++;
    chain = chain.then(async () => {
      if (disposed) return;
      try {
        // Presence frames renew independently every three seconds. Business
        // RPCs authenticate every request; do not add a database round trip
        // to the command/result path just to renew the same presence lease.
        if (disposed) return;
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
