import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;

test('offline UI clock expires, explicit disconnect wins and gateway never queues offline work', async () => {
  const presence = new URL(`.presence-${process.pid}.mjs`, import.meta.url);
  const files = new URL(`.presence-files-${process.pid}.mjs`, import.meta.url);
  await writeFile(presence, compile(await readFile(new URL('../src/cloud/presence.ts', import.meta.url), 'utf8')));
  await writeFile(files, compile(await readFile(new URL('../src/cloud/files.ts', import.meta.url), 'utf8')));
  try {
    const { deviceOnline, mergePresence } = await import(presence.href);
    const now = Date.now(), row = { wifi_connected: true, presence_seen: new Date(now).toISOString() };
    assert.equal(deviceOnline(row, now), true);
    assert.equal(deviceOnline(row, now + 10000), false);
    assert.equal(deviceOnline({ ...row, wifi_connected: false }, now), false);
    assert.equal(deviceOnline({ wifi_connected: true, presence_seen: 'invalid' }, now), false);
    const disconnected = { wifi_connected: false, presence_seen: new Date(now+1000).toISOString() };
    assert.equal(mergePresence(disconnected, row).wifi_connected, false, 'late snapshot must not restore stale online state');
    const { FilesGateway } = await import(files.href);
    let requests = 0;
    const gateway = new FilesGateway({ rpc() { requests++; throw new Error('must not enqueue'); } }, 'device', new AbortController().signal, () => {}, () => false);
    for (const op of ['list', 'music.play', 'music.stop', 'info', 'delete', 'put', 'get'])
      await assert.rejects(gateway.command(op, '/'), /Wi-Fi 未连接/);
    await assert.rejects(gateway.put(new File(['abc'], 'song.mp3'), '/music/song.mp3', false), /Wi-Fi 未连接/);
    assert.equal(requests, 0);
  } finally { await unlink(presence); await unlink(files); }
});

test('server rejects all offline queue entrypoints, cancels unclaimed work, guards stale socket close and expired leases', async () => {
  const db = new PGlite();
  const owner = '11111111-1111-4111-8111-111111111111';
  const s1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', s2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;
      create schema auth;create schema storage;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public,storage to anon,authenticated,service_role;
      grant execute on function auth.uid() to anon,authenticated,service_role;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
      alter table storage.objects enable row level security;grant select,insert,update,delete on storage.objects to authenticated;
      create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
      insert into auth.users values('${owner}');create publication supabase_realtime;`);
    for (const name of ['202609200001_link_cloud.sql','202610030001_file_commands.sql','202610030002_remote_commands.sql','202610030003_directory_pages.sql','202610030004_websocket.sql','202610030005_capacity.sql','202610030006_presence.sql'])
      await db.exec(await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8'));
    await db.exec(`insert into private.link_members values('${owner}')`);
    const role = async (r, user = '') => db.exec(`reset role;set role ${r};select set_config('request.jwt.claim.sub','${user}',false)`);
    const rpc = async (name, args) => (await db.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) as result`, args)).rows[0].result;
    await role('authenticated', owner);
    const d = await rpc('link_register_device', ['Presence test', 'ESP32-S3']);
    const queue = () => rpc('link_queue_command', [d.device_id, 'list', '/music', null, 0, false]);
    for (const [name, args] of [ ['link_queue_command',[d.device_id,'list','/music',null,0,false]], ['link_queue_remote',[d.device_id,'music.play','/music/a.mp3',{}]], ['link_create_task',[d.device_id,s1,false]] ])
      await assert.rejects(rpc(name,args), /WIFI_NOT_CONNECTED/);
    assert.equal((await db.query('select * from link_commands')).rows.length, 0);
    assert.equal((await db.query('select * from link_tasks')).rows.length, 0);
    await assert.rejects(rpc('link_queue_command_before_presence',[d.device_id,'list','/music',null,0,false]), /permission denied/);
    const presence = (event, session = s1) => rpc('link_device_presence', [d.device_id,d.token,event,session]);
    await assert.rejects(presence('open'), /permission denied/);
    await role('service_role'); await presence('open');
    await assert.rejects(rpc('link_device_presence',[d.device_id,'invalid','open',s1]), /Unauthorized/);
    await role('authenticated', owner); const queued = await queue();
    await role('service_role'); await presence('close');
    assert.equal(await presence('renew'), false, 'late renewal cannot resurrect a closed socket');
    await role('authenticated', owner);
    assert.equal((await db.query('select status from link_commands where id=$1',[queued])).rows[0].status, 'cancelled');
    await assert.rejects(queue(), /WIFI_NOT_CONNECTED/);
    await role('service_role'); await presence('open', s2);
    assert.equal(await presence('close', s1), false, 'old socket cannot disconnect its replacement');
    await role('authenticated', owner); const pending = await queue();
    await role('service_role');
    await rpc('link_device_command',[d.device_id,d.token,'command_claim',{}]);
    await presence('close', s2);
    await role('authenticated', owner);
    assert.equal((await db.query('select status from link_commands where id=$1',[pending])).rows[0].status,'running','active file buffers remain owned by the device');
    await role('service_role'); await presence('open',s2);
    await role('authenticated',owner); const abandoned = await queue();
    await db.exec('reset role');
    await db.query("update link_devices set presence_seen=clock_timestamp()-interval '11 seconds' where id=$1",[d.device_id]);
    await role('authenticated',owner); await assert.rejects(queue(),/WIFI_NOT_CONNECTED/);
    await role('service_role'); await presence('http',null);
    await role('authenticated',owner);
    assert.equal((await db.query('select status from link_commands where id=$1',[abandoned])).rows[0].status,'cancelled');
    assert.ok(await queue(), 'HTTP-only firmware can establish a short presence lease');
  } finally { await db.close(); }
});
