import { readFile, lstat, mkdir, writeFile, unlink, chmod, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { localPath } from './local-files.ts';

type Change = { path: string; before: string | null; after: string | null; mode?: number };
// Serialize patches within this runtime. External writers are checked again before commit.
let pending: Promise<unknown> = Promise.resolve();
export function applyPatch(patch: string) {
  const operation = pending.then(() => execute(patch));
  pending = operation.catch(() => {});
  return operation;
}
async function execute(patch: string) {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') throw new Error('Expected *** Begin Patch and *** End Patch.');
  const changes: Change[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < lines.length) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[i++]);
    if (!header) throw new Error('Expected Add File, Update File, or Delete File header.');
    const [, kind, name] = header;
    const path = localPath(name);
    if (seen.has(path)) throw new Error(`Duplicate path: ${name}`);
    seen.add(path);
    let before: string | null = null;
    let mode: number | undefined;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular file: ${name}`);
      mode = stat.mode;
      before = await readFile(path, 'utf8');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (kind === 'Add') {
      if (before !== null) throw new Error(`File already exists: ${name}`);
      const content: string[] = [];
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        if (!lines[i].startsWith('+')) throw new Error('Added lines must start with +.');
        content.push(lines[i++].slice(1));
      }
      changes.push({ path, before, after: content.length ? content.join('\n') + '\n' : '', mode });
    } else if (kind === 'Delete') {
      if (before === null) throw new Error(`File does not exist: ${name}`);
      changes.push({ path, before, after: null, mode });
    } else {
      if (before === null) throw new Error(`File does not exist: ${name}`);
      if (before.includes('\0')) throw new Error('Binary files are unsupported.');
      const crlf = before.includes('\r\n');
      const normalized = before.replace(/\r\n/g, '\n');
      const trailing = normalized.endsWith('\n');
      let source = normalized.split('\n');
      if (trailing) source.pop();
      let cursor = 0, hunks = 0;
      while (i < lines.length && lines[i].startsWith('@@')) {
        if (lines[i++] !== '@@') throw new Error('Use a plain @@ hunk header with exact context lines.');
        const old: string[] = [], replacement: string[] = [];
        let edited = false, eof = false;
        while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('*** ')) {
          const line = lines[i++];
          if (![' ', '+', '-'].includes(line[0])) throw new Error('Hunk lines must start with a space, +, or -.');
          if (line[0] !== '+') old.push(line.slice(1));
          if (line[0] !== '-') replacement.push(line.slice(1));
          if (line[0] !== ' ') edited = true;
        }
        if (lines[i] === '*** End of File') { eof = true; i++; }
        if (!old.length || !edited) throw new Error('Each update hunk needs existing context or removed lines, and a change.');
        const matches: number[] = [];
        for (let at = cursor; at <= source.length - old.length; at++) {
          if (eof && at + old.length !== source.length) continue;
          if (old.every((line, offset) => source[at + offset] === line)) matches.push(at);
        }
        if (matches.length !== 1) throw new Error(`Expected one exact hunk match in ${name}, found ${matches.length}. Read the file and add unique context.`);
        const at = matches[0];
        source.splice(at, old.length, ...replacement);
        cursor = at + replacement.length;
        hunks++;
      }
      if (!hunks) throw new Error('Update requires at least one @@ hunk.');
      let after = source.join('\n') + (trailing && source.length ? '\n' : '');
      if (crlf) after = after.replace(/\n/g, '\r\n');
      changes.push({ path, before, after, mode });
    }
  }
  if (!changes.length) throw new Error('Empty patch.');
  // Validate the entire patch before writing. This is not a filesystem transaction.
  for (const change of changes) {
    let now: string | null = null;
    try { now = await readFile(change.path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (now !== change.before) throw new Error(`File changed while preparing patch: ${change.path}`);
  }
  const applied: Change[] = [];
  try {
    for (const change of changes) {
      if (change.after === null) { await unlink(change.path); applied.push(change); }
      else {
        await mkdir(dirname(change.path), { recursive: true });
        const file = await open(change.path, change.before === null ? 'wx' : 'r+');
        applied.push(change);
        try { await file.truncate(0); await file.writeFile(change.after); } finally { await file.close(); }
      }
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const change of applied.reverse()) {
      try {
        if (change.before === null) await unlink(change.path);
        else { await writeFile(change.path, change.before); if (change.mode !== undefined) await chmod(change.path, change.mode); }
      } catch (failure) { rollbackErrors.push(`${change.path}: ${String(failure)}`); }
    }
    throw new Error(`Patch write failed: ${String(error)}. Rollback ${rollbackErrors.length ? 'failed: ' + rollbackErrors.join('; ') : 'completed'}.`);
  }
  return { changed: changes.map(c => ({ filePath: c.path, operation: c.before === null ? 'added' : c.after === null ? 'deleted' : 'updated' })) };
}
