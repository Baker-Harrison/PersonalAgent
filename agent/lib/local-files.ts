import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function localPath(path = '.') {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
  return resolve(process.env.EVE_PI_WORKDIR ?? process.cwd(), expanded);
}
