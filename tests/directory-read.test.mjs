import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';

test('late directory results match only the current device, command, page and request generation', async () => {
  const files = new URL(`./.directory-files-${process.pid}.mjs`, import.meta.url);
  const reads = new URL(`./.directory-read-${process.pid}.mjs`, import.meta.url);
  const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  await writeFile(files, compile(await readFile(new URL('../src/cloud/files.ts', import.meta.url), 'utf8')));
  await writeFile(reads, compile(await readFile(new URL('../src/cloud/directory-read.ts', import.meta.url), 'utf8')).replace(/from ['"]\.\/files['"]/g, `from './.directory-files-${process.pid}.mjs'`));
  try {
    const { DirectoryPendingError } = await import(files.href);
    const { DirectoryReads } = await import(reads.href);
    const tracker = new DirectoryReads();
    const deviceA = '0b73aa47-3ce6-481c-bb9f-9a4b2a6a62fe';
    const deviceB = 'cf5f1d19-2e1f-4ea9-bffb-fb05a728d4e4';
    const commandA = 'df7df81c-cc3a-4dab-a1b6-591aaf762af7';
    const commandB = 'c8372376-4e25-47bf-b26a-0bf829fb8a24';
    const job = {id:commandA,op:'list',path:'/music',cursor:8,status:'completed',error:null,result:{entries:[],cursor:8,end:true}};
    assert.equal(tracker.match(deviceA,job),null);

    const firstRequest = tracker.begin();
    const pending = new DirectoryPendingError(deviceA,commandA,'/music',8,[{name:'first.mp3',size:4,directory:false}]);
    tracker.defer(firstRequest,pending);
    const expected = tracker.pending;
    assert.equal(tracker.current(firstRequest),true);
    assert.equal(tracker.match(deviceA,job),expected);
    // A previous completed read of the same directory is never a replacement.
    assert.equal(tracker.match(deviceA,{...job,id:commandB}),null);
    assert.equal(tracker.match(deviceB,job),null);
    assert.equal(tracker.match('',job),null);
    assert.equal(tracker.match(deviceA,{...job,id:''}),null);
    assert.equal(tracker.match(deviceA,{...job,id:null}),null);
    assert.equal(tracker.match(deviceA,{...job,op:'music.list'}),null);
    assert.equal(tracker.match(deviceA,{...job,path:'/music/album'}),null);
    assert.equal(tracker.match(deviceA,{...job,cursor:0}),null);
    assert.equal(tracker.match(deviceA,{...job,cursor:'8'}),null);

    // Opening another directory or explicitly stopping increments generation,
    // so the previous async reply and previous async timeout cannot revive it.
    const secondRequest = tracker.begin();
    assert.equal(tracker.pending,null);
    assert.equal(tracker.current(firstRequest),false);
    assert.equal(tracker.match(deviceA,job),null);
    tracker.defer(firstRequest,pending);
    assert.equal(tracker.pending,null);
    const secondPending = new DirectoryPendingError(deviceA,commandB,'/novels',0);
    tracker.defer(secondRequest,secondPending);
    assert.equal(tracker.match(deviceA,job),null);
    const secondJob = {...job,id:commandB,path:'/novels',cursor:0};
    assert.equal(tracker.match(deviceA,secondJob),tracker.pending);
    tracker.defer(firstRequest,pending);
    assert.equal(tracker.pending.command,secondPending);

    // Switching devices rejects both old device replies and old command IDs,
    // even when both reads use the same directory and pagination cursor.
    const switchedRequest = tracker.begin();
    const switchedPending = new DirectoryPendingError(deviceB,commandB,'/music',8);
    tracker.defer(switchedRequest,switchedPending);
    assert.equal(tracker.match(deviceA,job),null);
    assert.equal(tracker.match(deviceB,job),null);
    const switchedJob = {...job,id:commandB};
    assert.equal(tracker.match(deviceA,switchedJob),null);
    assert.equal(tracker.match(deviceB,switchedJob),tracker.pending);
    tracker.begin();
    assert.equal(tracker.match(deviceB,switchedJob),null);
  } finally {
    await Promise.all([unlink(files),unlink(reads)]);
  }
});
