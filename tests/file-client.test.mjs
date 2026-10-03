import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';
import JSZip from 'jszip';

test('browser transfer checks hashes, walks paginated directories and preserves ZIP hierarchy', async () => {
  const compiled = new URL(`./.file-client-${process.pid}.mjs`, import.meta.url);
  await writeFile(compiled, ts.transpileModule(await readFile(new URL('../src/cloud/files.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  try {
    const { child, FilesGateway, sha256 } = await import(compiled.href);
    for (const name of ['..', 'a/b', 'a\\b', 'a.', 'a ', 'x:y']) assert.throws(() => child('/',name));
    assert.throws(() => child('/','.link')); assert.equal(child('/novels','中文.txt'),'/novels/中文.txt');
    const g = new FilesGateway({}, 'device', new AbortController().signal, () => {});
    let calls = 0;
    g.command = async (_op, _path, args) => { calls++; return args.p_cursor === 0 ? {entries:[{name:'a.txt',size:3,directory:false}],cursor:1,end:false} : {entries:[],cursor:1,end:true}; };
    assert.equal((await g.list('/')).length,1); assert.equal(calls,2);
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
    const dispatcher = new FilesGateway({
      rpc: async (name, args) => { sent.push({name,args}); return {data:'command-id'}; },
      from: () => ({select: () => ({eq: () => ({single: async () => ({data:{status:'completed',result:{state:'Playing',completion:'accepted'}}})})})})
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
  } finally { await unlink(compiled); }
});
