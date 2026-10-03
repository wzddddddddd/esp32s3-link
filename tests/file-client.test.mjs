import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';
import JSZip from 'jszip';

test('browser transfer checks hashes, walks paginated directories and preserves ZIP hierarchy', async t => {
  const compiled = new URL(`./.file-client-${process.pid}.mjs`, import.meta.url);
  await writeFile(compiled, ts.transpileModule(await readFile(new URL('../src/cloud/files.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  try {
    const { child, FilesGateway, DirectoryPendingError, sha256 } = await import(compiled.href);
    for (const name of ['..', 'a/b', 'a\\b', 'a.', 'a ', 'x:y']) assert.throws(() => child('/',name));
    assert.throws(() => child('/','.link')); assert.equal(child('/novels','中文.txt'),'/novels/中文.txt');
    const g = new FilesGateway({}, 'device', new AbortController().signal, () => {});
    let calls = 0;
    g.command = async (_op, _path, args) => { calls++; return args.p_cursor === 0 ? {entries:[{name:'a.txt',size:3,directory:false}],cursor:1,end:false} : {entries:[],cursor:1,end:true}; };
    assert.equal((await g.list('/')).length,1); assert.equal(calls,2);
    const pages = [];
    g.command = async (_op, _path, args) => {
      if (args.p_cursor === 0) return {entries:[{name:'song.mp3',size:3,directory:false}],cursor:1,end:false};
      throw new Error('second page unavailable');
    };
    await assert.rejects(g.list('/music', (items, complete) => pages.push({items,complete})), /second page/);
    assert.equal(pages[0].items[0].name, 'song.mp3');
    assert.equal(pages[0].complete, false);
    g.command = async () => { throw new Error('must not queue a completed directory again'); };
    assert.equal((await g.list('/music', undefined, {entries:[{name:'song.mp3',size:3,directory:false}],cursor:1,end:true})).length,1);
    g.command = async (_op, _path, args) => { assert.equal(args.p_cursor,1); return {entries:[],cursor:1,end:true}; };
    assert.equal((await g.list('/music', undefined, {entries:[{name:'song.mp3',size:3,directory:false}],cursor:1,end:false})).length,1);
    g.command = async () => ({entries:[],cursor:0,end:false}); await assert.rejects(g.list('/'),/游标/);
    const content = new Blob(['abc']);
    g.list = async p => p === '/' ? [{name:'empty',size:0,directory:true},{name:'novels',size:0,directory:true}] : p === '/novels' ? [{name:'中文.txt',size:3,directory:false}] : [];
    g.get = async p => {assert.equal(p,'/novels/中文.txt'); return content;};
    const zip = await JSZip.loadAsync(await (await g.zip('/')).arrayBuffer());
    assert.ok(zip.files['sdcard/empty/'].dir);
    assert.equal(await zip.file('sdcard/novels/中文.txt').async('string'),'abc');
    let expected = await sha256(content);
    const client = {
      from: () => ({select: () => ({eq: () => ({single: async () => ({data:{storage_path:'path',size_bytes:3,sha256:expected}})})})}),
      storage: {from: () => ({createSignedUrl: async () => ({data:{signedUrl:'https://example.invalid/file'}})})}
    };
    const fetchBefore = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response(content);
      const receiver = new FilesGateway(client,'device',new AbortController().signal,()=>{});
      assert.equal(await (await receiver.resource('id')).text(),'abc');
      expected='b'.repeat(64); await assert.rejects(receiver.resource('id'),/SHA-256/);
    } finally { globalThis.fetch = fetchBefore; }
    const cancelled = new AbortController(); cancelled.abort();
    const sent = [];
    const reply = data => Object.assign(Promise.resolve({data}), {abortSignal: () => Promise.resolve({data})});
    const dispatcher = new FilesGateway({
      rpc: (name, args) => { sent.push({name,args}); return reply('command-id'); },
      from: () => ({select: () => ({eq: () => ({abortSignal: () => ({single: () => reply({status:'completed',result:{state:'Playing',completion:'accepted'}})})})})})
    }, 'device', new AbortController().signal, () => {});
    await dispatcher.command('music.volume', '/', {volume:42});
    assert.equal(sent[0].name,'link_queue_remote');
    assert.deepEqual(sent[0].args.p_args,{volume:42});
    await dispatcher.command('delete','/music/song.mp3');
    assert.equal(sent[1].name,'link_queue_remote');
    await dispatcher.command('list','/music',{p_cursor:8});
    assert.equal(sent[2].name,'link_queue_command');
    assert.equal(sent[2].args.p_cursor,8);
    const stopped = new FilesGateway({},'device',cancelled.signal,()=>{});
    await assert.rejects(stopped.command('get','/x'));
    const flush = () => new Promise(resolve => setImmediate(resolve));
    // A known directory request survives the foreground deadline. Its result
    // arriving at 250 seconds can be displayed without queuing the same page.
    t.mock.timers.enable({apis:['setTimeout']});
    const lateCalls = [];
    let lateReply = {status:'running',result:null};
    const lateResult = {entries:[{name:'late.mp3',size:3,directory:false}],cursor:1,end:true};
    setTimeout(() => { lateReply = {status:'completed',result:lateResult}; },250000);
    const late = new FilesGateway({
      rpc: (name,args) => { lateCalls.push({name,args}); return reply('late-command'); },
      from: () => ({select: () => ({eq: () => ({abortSignal: () => ({single: () => reply(lateReply)})})})})
    },'device',new AbortController().signal,()=>{});
    const waiting = late.list('/music').catch(error => error);
    await flush(); t.mock.timers.tick(90000);
    const pending = await waiting;
    assert.ok(pending instanceof DirectoryPendingError);
    assert.deepEqual({device:pending.device,id:pending.id,path:pending.path,cursor:pending.cursor,entries:pending.entries},
      {device:'device',id:'late-command',path:'/music',cursor:0,entries:[]});
    assert.equal(lateCalls.length,1); assert.equal(lateCalls[0].name,'link_queue_command');
    t.mock.timers.tick(160000);
    assert.equal(lateReply.status,'completed');
    assert.deepEqual(await late.list(pending.path,undefined,lateReply.result,pending),lateResult.entries);
    assert.equal(lateCalls.length,1,'the already completed directory must not be submitted again');
    t.mock.timers.reset();

    // Resume a delayed second page at its original cursor, retaining page one
    // and submitting only page three when the late page is not the final one.
    t.mock.timers.enable({apis:['setTimeout']});
    const paginatedCalls = [], pagesById = new Map();
    const firstEntry = {name:'first.mp3',size:4,directory:false};
    const secondEntry = {name:'second.mp3',size:5,directory:false};
    const thirdEntry = {name:'third.mp3',size:6,directory:false};
    const paginated = new FilesGateway({
      rpc: (name,args) => {
        paginatedCalls.push({name,args});
        const id = `page-${args.p_cursor}`;
        pagesById.set(id,args.p_cursor === 0 ? {status:'completed',result:{entries:[firstEntry],cursor:1,end:false}} : args.p_cursor === 1 ? {status:'running',result:null} : {status:'completed',result:{entries:[thirdEntry],cursor:3,end:true}});
        return reply(id);
      },
      from: () => ({select: () => ({eq: (_column,id) => ({abortSignal: () => ({single: () => reply(pagesById.get(id))})})})})
    },'device',new AbortController().signal,()=>{});
    const partialPages = [];
    const secondWaiting = paginated.list('/music',(entries,complete) => partialPages.push({entries,complete})).catch(error => error);
    await flush(); t.mock.timers.tick(90000);
    const secondPending = await secondWaiting;
    assert.ok(secondPending instanceof DirectoryPendingError);
    assert.equal(secondPending.id,'page-1'); assert.equal(secondPending.cursor,1);
    assert.deepEqual(secondPending.entries,[firstEntry]);
    assert.deepEqual(partialPages,[{entries:[firstEntry],complete:false}]);
    assert.deepEqual(paginatedCalls.map(call => call.args.p_cursor),[0,1]);
    const secondResult = {entries:[secondEntry],cursor:2,end:false};
    const resumedPages = [];
    assert.deepEqual(await paginated.list('/music',(entries,complete) => resumedPages.push({entries,complete}),secondResult,secondPending),[firstEntry,secondEntry,thirdEntry]);
    assert.deepEqual(paginatedCalls.map(call => call.args.p_cursor),[0,1,2]);
    assert.deepEqual(resumedPages,[{entries:[firstEntry,secondEntry],complete:false},{entries:[firstEntry,secondEntry,thirdEntry],complete:true}]);
    await assert.rejects(paginated.list('/music',undefined,{entries:[],cursor:1,end:false},secondPending),/游标/);
    t.mock.timers.reset();

    // An explicit stop still cancels an unclaimed directory command rather
    // than registering it for eventual background display.
    const explicitStop = new AbortController(), stoppedCalls = [];
    const manuallyStopped = new FilesGateway({
      rpc: (name,args) => { stoppedCalls.push({name,args}); return reply('stop-command'); },
      from: () => ({select: () => ({eq: () => ({abortSignal: () => ({single: () => reply({status:'waiting',result:null})})})})})
    },'device',explicitStop.signal,()=>{});
    const stoppedWaiting = assert.rejects(manuallyStopped.list('/music'),error => !(error instanceof DirectoryPendingError));
    await flush(); explicitStop.abort(); await stoppedWaiting;
    assert.deepEqual(stoppedCalls.map(call => call.name),['link_queue_command','link_cancel_command']);
    assert.equal(stoppedCalls[1].args.p_id,'stop-command');

    // A hung queue response must time out too, but without a known command ID
    // it cannot be recovered or cancelled by guessing a historical request.
    t.mock.timers.enable({apis:['setTimeout']});
    const hang = {abortSignal: signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true}))};
    const unknownCalls = [];
    const timed = new FilesGateway({rpc: name => { unknownCalls.push(name); return hang; }}, 'device', new AbortController().signal, () => {});
    const timeoutCheck = assert.rejects(timed.command('list','/music'),error => !(error instanceof DirectoryPendingError) && /90 秒/.test(error.message));
    t.mock.timers.tick(90000);
    await timeoutCheck;
    assert.deepEqual(unknownCalls,['link_queue_command']);
    t.mock.timers.reset();
  } finally { await unlink(compiled); }
});
