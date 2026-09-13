import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Model-generated links are untrusted. Opening files reveals them in Finder;
// it never executes an application or shell command.
export function linkTarget(value: string, folder: string): { url: string } | { path: string } {
  if (!value || value.length > 8192 || /[\u0000-\u001f]/.test(value)) throw new Error('Invalid link.');
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password) throw new Error('Links containing credentials cannot be opened.');
    return { url: url.href };
  }
  if(value.startsWith('sandbox:/'))value=value.slice('sandbox:'.length);
  if(value.startsWith('file:'))return {path:fileURLToPath(value)};
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//') || value.startsWith('#')) throw new Error('Unsupported link.');
  return { path: resolve(folder, decodeURIComponent(value).replace(/(?::\d+(?::\d+)?|#L\d+)$/, '')) };
}
