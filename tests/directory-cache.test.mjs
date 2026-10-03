import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

test('navigation cache isolates devices, expires, preserves pagination and invalidates after mutations', async () => {
  const source = await readFile(new URL('../src/cloud/directory-cache.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const { DirectoryCache } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  const cache = new DirectoryCache(30000, 2), entries = [{ name: 'song.mp3', size: 8, directory: false }];
  cache.put('a', '/music', entries, false, 32, 1000);
  entries[0].name = 'changed';
  assert.equal(cache.get('a', '/music', 2000).entries[0].name, 'song.mp3');
  assert.equal(cache.get('b', '/music', 2000), undefined);
  assert.equal(cache.get('a', '/music', 2000).cursor, 32);
  assert.equal(cache.get('a', '/music', 2000).complete, false);
  assert.equal(cache.get('a', '/music', 31000), undefined);
  cache.put('a', '/music', entries, true, 1, 32000);
  cache.put('b', '/music', entries, true, 1, 32000);
  cache.invalidate('a');
  assert.equal(cache.get('a', '/music', 33000), undefined);
  assert.ok(cache.get('b', '/music', 33000));
  cache.put('b', '/video', entries, true, 1, 32000);
  cache.put('b', '/novels', entries, true, 1, 32000);
  assert.equal(cache.get('b', '/music', 33000), undefined);
});
