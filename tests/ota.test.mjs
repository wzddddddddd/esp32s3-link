import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
const compile = source => ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
async function modules() {
  const files = ['firmware','ota','protocol'].map(name => new URL(`.ota-${name}-${process.pid}.mjs`,import.meta.url));
  const sources = ['../supabase/functions/_shared/firmware.ts','../src/cloud/ota.ts','../supabase/functions/device-gateway/protocol.ts'];
  for (let i=0;i<files.length;i++) {
    let source=await readFile(new URL(sources[i],import.meta.url),'utf8');
    if(i===1)source=source.replace("'../../supabase/functions/_shared/firmware'",JSON.stringify(files[0].href))
      .replace("import { deviceOnline, OFFLINE_MESSAGE } from './presence';", "const deviceOnline=()=>true; const OFFLINE_MESSAGE='Wi-Fi 未连接';");
    await writeFile(files[i],compile(source));
  }
  return {firmware:await import(files[0].href),ota:await import(files[1].href),protocol:await import(files[2].href),cleanup:()=>Promise.all(files.map(unlink))};
}
async function appImage(project='display_example') {
  const bytes=new Uint8Array(336),view=new DataView(bytes.buffer);
  bytes[0]=0xe9;bytes[1]=1;bytes[3]=0x40;bytes[12]=9;bytes[23]=1;
  view.setUint32(28,256,true);view.setUint32(32,0xabcd5432,true);
  bytes.set(new TextEncoder().encode('1.0.0'),48);bytes.set(new TextEncoder().encode(project),80);
  let checksum=0xef;for(const byte of bytes.subarray(32,288))checksum^=byte;bytes[303]=checksum;
  bytes.set(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.slice(0,304))),304);
  return bytes;
}
test('OTA validates actual main images, treats acceptance separately and signs only verified private bytes',async()=>{
  const m=await modules();
  try {
    const bytes=await appImage(),details=await m.firmware.inspectMainFirmware(bytes);
    assert.equal(details.target_role,'main');assert.equal(details.project_name,'display_example');
    await assert.rejects(m.firmware.inspectMainFirmware(await appImage('ota_recovery')),/主程序/);
    const wrongChip=bytes.slice();wrongChip[12]=0;await assert.rejects(m.firmware.inspectMainFirmware(wrongChip),/ESP32-S3/);
    const corrupt=bytes.slice();corrupt[100]^=1;await assert.rejects(m.firmware.inspectMainFirmware(corrupt),/校验和/);
    const corruptHash=bytes.slice();corruptHash[335]^=1;await assert.rejects(m.firmware.inspectMainFirmware(corruptHash),/SHA-256/);
    await assert.rejects(m.firmware.inspectMainFirmware(new Uint8Array(4194305)),/4 MiB/);
    const expected={job:'job',size:details.size,sha256:details.sha256};
    const status={...expected,total:details.size,received:details.size,phase:'verified',active:false,main_dirty:false,can_return:true};
    assert.equal(m.ota.verifiedFor(status,expected),true);
    for(const diff of [{phase:'receiving',accepted:true},{job:'other'},{sha256:'b'.repeat(64)},{received:0},{active:true},{main_dirty:true}])
      assert.equal(m.ota.verifiedFor({...status,...diff},expected),false);
    assert.equal(m.ota.canReturn({...status,main_dirty:true}),false);
    assert.equal(m.ota.canReturn({...status,return_pending:true}),false);
    let failed=0,signed=0,blob=bytes;
    const command={id:'command',op:'ota.install',job:'job',target_role:'main',size:details.size,sha256:details.sha256,download_path:'owner/private/payload'};
    const client={rpc:async(_name,args)=>args.p_action==='command_claim'?{data:{command}}:(failed++,{data:{ok:true}}),
      storage:{from:()=>({download:async()=>({data:new Blob([blob])}),createSignedUrl:async()=>{signed++;return {data:{signedUrl:'https://signed/private'}};}})}};
    const reply=await m.protocol.executeRequest(client,'device','token',{action:'command_claim'},m.firmware.inspectMainFirmware);
    assert.equal(reply.body.command.download_url,'https://signed/private');assert.equal(reply.body.command.download_path,undefined);
    blob=corrupt;
    assert.equal((await m.protocol.executeRequest(client,'device','token',{action:'command_claim'},m.firmware.inspectMainFirmware)).body.command,null);
    assert.equal(signed,1);assert.equal(failed,1);
    const traces=[];
    const gateway=new m.ota.OtaGateway({},'device',new AbortController().signal,()=>{});
    let main=false;
    gateway.device=async()=>({firmware_mode:main?'main':'recovery',ota:status});
    gateway.command=async(op,args)=>{traces.push([op,args]);if(op==='ota.install')return {accepted:true,status:{phase:'receiving'}};
      if(op==='ota.status')return {...status,job:expected.job};if(op==='ota.return'){main=true;return {accepted:true};}throw new Error('unexpected op');};
    assert.equal((await gateway.install({id:'resource',size_bytes:details.size,sha256:details.sha256},expected.job)).phase,'verified');
    assert.deepEqual(traces.map(([op])=>op),['ota.install','ota.status']);
    assert.equal((await gateway.returnMain(expected.job)).firmware_mode,'main');
    assert.deepEqual(traces.map(([op])=>op),['ota.install','ota.status','ota.status','ota.return']);
    main=false;gateway.command=async(op)=>op==='ota.install'?{accepted:true}:({...status,sha256:'b'.repeat(64)});
    await assert.rejects(gateway.install({id:'resource',size_bytes:details.size,sha256:details.sha256},expected.job),/不一致/);
  } finally {await m.cleanup();}
});

test('OTA database isolates modes, authenticates ownership, validates args and keeps accepted install distinct from verified',async()=>{
  const db=new PGlite(),owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
  const job='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',hash='a'.repeat(64);
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
      insert into auth.users values('${owner}'),('${other}');create publication supabase_realtime;`);
    const migrations=['202609200001_link_cloud.sql','202610030001_file_commands.sql','202610030002_remote_commands.sql',
      '202610030003_directory_pages.sql','202610030004_websocket.sql','202610030005_capacity.sql','202610030006_presence.sql','202610040001_recovery_ota.sql'];
    for(const name of migrations)await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
    await db.exec(`insert into private.link_members values('${owner}'),('${other}')`);
    const role=(name,user='')=>db.exec(`reset role;set role ${name};select set_config('request.jwt.claim.sub','${user}',false)`);
    const rpc=async(name,args)=>(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;
    await role('authenticated',owner);const d=await rpc('link_register_device',['OTA test','ESP32-S3']);
    const queue=(op,args={},resource=null)=>rpc('link_queue_ota',[d.device_id,op,args,resource]);
    await assert.rejects(queue('ota.enter',{job,target_role:'main'}),/WIFI_NOT_CONNECTED/);
    const path=`${owner}/${job}/payload`;
    await db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)',['link-resources',path,{size:336,mimetype:'application/octet-stream'}]);
    const firmware=await rpc('link_register_resource',[path,'main.bin','firmware',hash]);
    const cmd=(action,payload={})=>rpc('link_device_command',[d.device_id,d.token,action,payload]);
    const heartbeat=(mode,ota)=>rpc('link_device_request',[d.device_id,d.token,'heartbeat',{hardware:'ESP32-S3',capacity_bytes:1000,used_bytes:0,mode,ota}]);
    await role('service_role');await rpc('link_device_presence',[d.device_id,d.token,'open',job]);
    await heartbeat('main',{phase:'ready',active:false,main_dirty:false,can_return:false});
    await role('authenticated',owner);
    for(const args of [{job,target_role:'recovery'},{job,target_role:'main',download_url:'https://arbitrary'},{target_role:'main'}])
      await assert.rejects(queue('ota.enter',args),/OTA|Missing/);
    await assert.rejects(queue('ota.install',{job,target_role:'main'},firmware),/RECOVERY_REQUIRED/);
    const enter=await queue('ota.enter',{job,target_role:'main'});
    await assert.rejects(rpc('link_queue_remote',[d.device_id,'music.play','/music/song.mp3',{}]),/DEVICE_RECOVERY_MODE/);
    await role('service_role');assert.equal((await cmd('command_claim')).command.id,enter);
    await cmd('command_result',{id:enter,status:'completed',result:{accepted:true,mode:'main',phase:'handoff',job}});
    await heartbeat('recovery',{phase:'ready',job,active:false,main_dirty:false,can_return:true,received:0,total:0});
    await role('authenticated',other);await assert.rejects(queue('ota.status'),/Device not owned/);
    assert.equal((await db.query('select * from link_devices')).rows.length,0);
    await role('authenticated',owner);
    await assert.rejects(rpc('link_queue_command',[d.device_id,'list','/music',null,0,false]),/DEVICE_RECOVERY_MODE/);
    await assert.rejects(rpc('link_queue_remote',[d.device_id,'music.stop','/',{}]),/DEVICE_RECOVERY_MODE/);
    const install=await queue('ota.install',{job,target_role:'main'},firmware);
    await assert.rejects(queue('ota.install',{job,target_role:'main'},firmware),/OTA_BUSY/);
    await role('service_role');const claimed=(await cmd('command_claim')).command;
    assert.equal(claimed.id,install);assert.equal(claimed.size,336);assert.equal(claimed.sha256,hash);assert.equal(claimed.download_path,path);
    await cmd('command_result',{id:install,status:'completed',result:{accepted:true,status:{phase:'receiving',job}}});
    await role('authenticated',owner);
    assert.equal((await db.query('select ota from link_devices where id=$1',[d.device_id])).rows[0].ota.phase,'ready','accepted command must not fabricate verified heartbeat');
    await role('service_role');
    await heartbeat('recovery',{phase:'receiving',job,active:true,main_dirty:true,can_return:false,received:32,total:336});
    await role('authenticated',owner);await assert.rejects(queue('ota.return',{job}),/MAIN_DIRTY_OR_BUSY/);
    const cancel=await queue('ota.cancel',{job});
    await role('service_role');assert.equal((await cmd('command_claim')).command.id,cancel);
    await cmd('command_result',{id:cancel,status:'completed',result:{cancelled:true}});
    await heartbeat('recovery',{phase:'verified',job,active:false,main_dirty:false,can_return:true,received:336,total:336,sha256:hash});
    await role('authenticated',owner);assert.match(await queue('ota.return',{job}),/^[0-9a-f-]{36}$/);
    await role('anon');await assert.rejects(queue('ota.status'),/permission denied/);
    await role('service_role');await assert.rejects(rpc('link_device_request',[d.device_id,'b'.repeat(64),'heartbeat',{}]),/Unauthorized/);
    await assert.rejects(heartbeat('unknown',{}),/Invalid firmware mode/);
    await assert.rejects(heartbeat('recovery',{phase:'receiving',received:4194305}),/Invalid OTA snapshot/);
  } finally {await db.close();}
});
