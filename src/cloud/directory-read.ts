import { DirectoryPendingError, type Command } from './files';

export interface PendingDirectory { request: number; command: DirectoryPendingError }

// Only the directory the user is currently browsing may apply a late result.
// Task history can contain other completed reads of the same path.
export class DirectoryReads {
  private version = 0;
  pending: PendingDirectory | null = null;
  begin() { this.pending = null; return ++this.version; }
  current(request: number) { return request === this.version; }
  defer(request: number, command: DirectoryPendingError) {
    if (this.current(request)) this.pending = { request, command };
  }
  match(device: string, job: Command) {
    const pending = this.pending;
    if (!pending || !this.current(pending.request)) return null;
    const expected = pending.command;
    return device === expected.device && job.id === expected.id && job.op === 'list'
      && job.path === expected.path && job.cursor === expected.cursor ? pending : null;
  }
}
