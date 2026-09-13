import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicJson, ensureDirectory } from '../agent/lib/credentials.ts';
import { createPi, providerId } from '../agent/lib/pi.ts';

export class Onboarding {
  private controller?: AbortController;
  private pending?: Promise<void>;
  constructor(private directory: string, private open: (url: string) => Promise<void>, private finished: () => void, private pi = createPi()) {}
  async complete() {
    try { return JSON.parse(await readFile(join(this.directory, 'onboarding.json'), 'utf8')).completed === true; }
    catch { return false; }
  }
  async save() {
    await ensureDirectory(this.directory);
    await atomicJson(join(this.directory, 'onboarding.json'), { completed: true });
  }
  start() {
    if (this.pending) return this.pending;
    const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(), 5 * 60_000);
    this.pending = (async () => {
      try {
        await this.pi.login(providerId, 'oauth', {
          signal: controller.signal,
          prompt: async prompt => {
            if (prompt.type === 'select') return 'browser';
            // Browser callback resolves the login. No codes or credentials cross renderer IPC.
            const signal = prompt.signal ? AbortSignal.any([prompt.signal, controller.signal]) : controller.signal;
            return new Promise<string>((_resolve, reject) => {
              const abort = () => reject(new Error('Sign-in cancelled.'));
              if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
            });
          },
          notify: event => {
            if (event.type === 'auth_url') {
              const url = new URL(event.url);
              if (url.origin !== 'https://auth.openai.com') { controller.abort(); return; }
              void this.open(url.href).catch(() => controller.abort());
            }
          },
        });
        controller.signal.throwIfAborted();
        await this.save();
        this.finished();
      } catch {
        throw new Error(controller.signal.aborted ? 'Sign-in cancelled or timed out. Try again when you are ready.' : 'Sign-in did not finish. Try again. Close any other ChatGPT login window first.');
      } finally { clearTimeout(timer); this.controller = undefined; this.pending = undefined; }
    })();
    return this.pending;
  }
  cancel() { this.controller?.abort(); }
  async useExisting() {
    if ((await this.pi.checkAuth(providerId))?.type !== 'oauth') throw new Error('Sign in with ChatGPT to continue.');
    await this.save();
    this.finished();
  }
}
