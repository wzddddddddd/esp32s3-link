import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';

test('capacity treats opaque partitions as unknown and supports a server without the new column', async () => {
  const clientFile = new URL(`./.capacity-client-${process.pid}.mjs`, import.meta.url);
  const storageFile = new URL(`./.capacity-storage-${process.pid}.mjs`, import.meta.url);
  const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  await writeFile(clientFile, compile(await readFile(new URL('../src/cloud/client.ts', import.meta.url), 'utf8')));
  await writeFile(storageFile, compile(await readFile(new URL('../src/cloud/storage.ts', import.meta.url), 'utf8')));
  try {
    const { measured } = await import(storageFile.href);
    assert.equal(measured({total:1000,used:100,free:900}),true);
    for (const row of [{total:1000}, {total:0,used:0,free:0}, {total:1000,used:1001,free:0}, {total:1000,used:0,free:-1}, {total:1000,used:NaN,free:900}]) assert.equal(measured(row),false);
    const { snapshot } = await import(clientFile.href);
    let missingColumn = true;
    let error = {code:'42703',message:'column link_devices.storage does not exist'};
    const selections = [];
    const row = {id:'test',capacity_bytes:1000,used_bytes:100};
    const client = {
      rpc: async () => ({data:true,error:null}),
      from(table) {
        let columns;
        const query = { select(value) { columns=value; selections.push([table,value]); return query; }, returns() { return query; }, order() { return query; }, limit() { return query; },
          then(resolve,reject) { return Promise.resolve(table==='link_devices' ? missingColumn && columns.includes('storage') ? {error,data:null} : {error:null,data:[row]} : {error:null,data:[]}).then(resolve,reject); } };
        return query;
      },
    };
    assert.deepEqual((await snapshot(client)).devices,[row]);
    assert.equal(selections.filter(([table])=>table==='link_devices').length,2);
    error={code:'42501',message:'permission denied'};
    await assert.rejects(snapshot(client),e=>e===error);
    missingColumn=false;
    assert.deepEqual((await snapshot(client)).devices,[row]);
  } finally { await Promise.all([unlink(clientFile),unlink(storageFile)]); }
});
