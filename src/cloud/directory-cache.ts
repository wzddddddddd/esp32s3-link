import type { Entry } from './files';

export interface CachedDirectory { entries: Entry[]; complete: boolean; cursor: number; savedAt: number }
/** Navigation cache only: explicit refresh and every file mutation bypass it. */
export class DirectoryCache {
  private rows = new Map<string, CachedDirectory>();
  constructor(private ttlMs = 30000, private limit = 12) {}
  private key(device: string, path: string) { return JSON.stringify([device, path]); }
  get(device: string, path: string, now = Date.now()): CachedDirectory | undefined {
    const key = this.key(device, path), row = this.rows.get(key);
    if (!row) return;
    if (now - row.savedAt >= this.ttlMs || now < row.savedAt) { this.rows.delete(key); return; }
    return { ...row, entries: row.entries.map(entry => ({ ...entry })) };
  }
  put(device: string, path: string, entries: Entry[], complete: boolean, cursor: number, now = Date.now()) {
    const key = this.key(device, path);
    this.rows.delete(key);
    this.rows.set(key, { entries: entries.map(entry => ({ ...entry })), complete, cursor, savedAt: now });
    while (this.rows.size > this.limit) this.rows.delete(this.rows.keys().next().value!);
  }
  invalidate(device: string) {
    for (const key of this.rows.keys()) if (JSON.parse(key)[0] === device) this.rows.delete(key);
  }
}
