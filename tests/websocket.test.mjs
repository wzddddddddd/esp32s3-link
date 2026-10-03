import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';
const compile = source => ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
test('device socket serializes requests, pushes wakeups and cleans subscriptions', async () => {
  const output = new URL(`.ws-protocol-${process.pid}.mjs`,import.meta.url);
  await writeFile(output,compile(await readFile(new URL('../supabase/functions/device-gateway/protocol.ts',import.meta.url),'utf8')));
  try {
    const {parseRequest,attachDeviceSocket,executeRequest} = await import(output.href);
    assert.throws(()=>parseRequest('{"action":"delete_everything"}'));
    assert.throws(()=>parseRequest('{"action":"command_claim","payload":[]}'));
    assert.throws(()=>parseRequest(' '.repeat(65537)),/PAYLOAD_TOO_LARGE/);
    let notify, unsubscribed=0, executed=[], release;
    const sent=[], socket={readyState:1,send:text=>sent.push(JSON.parse(text)),close:()=>{socket.readyState=3;socket.onclose?.();}};
    const cleanup=attachDeviceSocket(socket,async input=>{
      executed.push(input.action);
      if(executed.length===1) await new Promise(resolve=>{release=resolve;});
      return {status:200,body:{ok:true}};
    },wake=>{notify=wake;return ()=>{unsubscribed++;};});
    socket.onopen(); assert.deepEqual(sent.map(x=>x.type),['ready','wake']);
    notify(); assert.equal(sent.at(-1).type,'wake');
    socket.onmessage({data:JSON.stringify({id:1,action:'command_claim'})});
    socket.onmessage({data:JSON.stringify({id:2,action:'command_result',payload:{id:'command',status:'completed'}})});
    await flush(); assert.deepEqual(executed,['command_claim']);
    release(); await flush(); assert.deepEqual(executed,['command_claim','command_result']);
    assert.deepEqual(sent.filter(x=>x.id).map(x=>x.id),[1,2]);
    cleanup(); cleanup(); assert.equal(unsubscribed,1);
    const count=sent.length;notify();assert.equal(sent.length,count);
    const invalid={readyState:1,send(){},close(){this.readyState=3;}};
    attachDeviceSocket(invalid,async()=>({status:200,body:{}}),()=>()=>{});
    invalid.onmessage({data:'bad json'});assert.equal(invalid.readyState,3);
    const unauthorized={readyState:1,send(){},close(){this.readyState=3;}};
    attachDeviceSocket(unauthorized,async()=>({status:401,body:{error:'UNAUTHORIZED'}}),()=>()=>{});
    unauthorized.onmessage({data:'{"id":1,"action":"command_claim"}'});await flush();assert.equal(unauthorized.readyState,3);
    const events=[];
    let unblock;
    const liveSocket={readyState:1,send(){},close(){this.readyState=3;this.onclose?.();}};
    attachDeviceSocket(liveSocket,async()=>{await new Promise(resolve=>{unblock=resolve;});return {status:200,body:{}};},()=>()=>{},async event=>{events.push(event);});
    liveSocket.onopen();await flush();assert.deepEqual(events,['open']);
    liveSocket.onmessage({data:'{"id":1,"action":"command_claim"}'});await flush();
    liveSocket.onmessage({data:'{"type":"presence"}'});await flush();
    assert.deepEqual(events,['open','renew','renew'],'presence bypasses a blocked business request');
    liveSocket.close();await flush();assert.equal(events.at(-1),'close');
    unblock();await flush();
    let args;
    const reply=await executeRequest({rpc:async(_rpc,p)=>{args=p;return {error:{code:'28000',message:'secret SQL'}};}},'device','token',{action:'command_claim'});
    assert.equal(args.p_token,'token');assert.deepEqual(reply,{status:401,body:{error:'UNAUTHORIZED'}});
  } finally {await unlink(output);}
});
test('browser completes from its own pushed command without waiting for a polling timer', async () => {
  const output=new URL(`.ws-browser-${process.pid}.mjs`,import.meta.url);
  await writeFile(output,compile(await readFile(new URL('../src/cloud/files.ts',import.meta.url),'utf8')));
  try {
    const {FilesGateway}=await import(output.href);
    let update, reads=0, removed=0;
    const channel={on:(_event,filter,callback)=>{assert.equal(filter.filter,'device_id=eq.device');update=callback;return channel;},subscribe:callback=>{callback('SUBSCRIBED');return channel;}};
    const client={channel:()=>channel,removeChannel:async c=>{assert.equal(c,channel);removed++;},
      rpc:()=>({abortSignal:async()=>({data:'own-command'})}),
      from:()=>({select:()=>({eq:()=>({abortSignal:()=>({single:async()=>{reads++;return {data:{id:'own-command',status:'waiting'}};}})})})})};
    const gateway=new FilesGateway(client,'device',new AbortController().signal,()=>{});
    let finished=false;
    const pending=gateway.command('list','/music').then(r=>{finished=true;return r;});
    await flush();assert.equal(reads,1);
    update({new:{id:'other-command',status:'completed',result:{wrong:true}}});
    await flush();assert.equal(finished,false);
    const result={entries:[{name:'song.mp3',size:3,directory:false}],cursor:1,end:true};
    update({new:{id:'own-command',status:'completed',result}});
    assert.deepEqual(await pending,result);assert.equal(reads,1);assert.equal(removed,1);
    // A healthy subscription can have no publication/events: queries still
    // recover results quickly instead of adding ten seconds to every click.
    reads = 0;
    const silent = { ...client, from: () => ({ select: () => ({ eq: () => ({ abortSignal: () => ({ single: async () => ({ data: ++reads === 1 ? { id: 'own-command', status: 'running' } : { id: 'own-command', status: 'completed', result } }) }) }) }) }) };
    const started = Date.now();
    assert.deepEqual(await new FilesGateway(silent, 'device', new AbortController().signal, () => {}).command('list', '/music'), result);
    assert.equal(reads, 2);
    assert.ok(Date.now() - started < 3000, 'missing pushed event must not add ten seconds');
    const paged = new FilesGateway({},'device',new AbortController().signal,()=>{});
    const cursors=[], shown=[];
    paged.command=async(_op,_path,args)=>{
      cursors.push(args.p_cursor);
      return args.p_cursor===0 ? {entries:result.entries,cursor:1,end:false}
        : {entries:[{name:'second.mp3',size:4,directory:false}],cursor:2,end:true};
    };
    const first=await paged.list('/music',(entries,end,cursor)=>shown.push({entries,end,cursor}),undefined,undefined,1);
    assert.deepEqual(cursors,[0]);assert.equal(shown[0].end,false);assert.equal(shown[0].cursor,1);
    const complete=await paged.list('/music',undefined,undefined,{cursor:1,entries:first},1);
    assert.deepEqual(cursors,[0,1]);assert.equal(complete.length,2);
  } finally {await unlink(output);}
});
