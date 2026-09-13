import { assignWorkerNames } from './worker-names.ts';
import { mkdir, readFile, realpath, stat, writeFile, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ReasoningLabel } from '../agent/lib/reasoning.ts';

export type Selection = { model: string; reasoning: ReasoningLabel };
export type Attachment = {path:string;name:string;size?:number;mediaType?:string};
export type ChatMessage = { id: string; attachments?: Attachment[]; role: 'user' | 'assistant' | 'error' | 'worker' | 'tool'; text: string; at: number; workerId?: string; toolStatus?: 'preparing' | 'running' | 'done' | 'failed'; delivery?: 'sending' | 'accepted' | 'received' | 'uncertain' | 'failed' };
export type Activity = { id: string; name: string; status: 'preparing' | 'running' | 'done' | 'failed' | 'stopped'; at: number; input?: string; output?: string };
export type Worker = { id: string; sessionId: string; status: string; task: string; output: string; cursor: number;
  displayName?: string; name?: string; activity?: Activity[]; anchorMessageId?: string; startedAt?: number; updatedAt?: number; turnId?: string;
  updates?: { id: string; text: string; at: number; kind: 'progress' | 'steering' }[] };
export type Project = {
  removed?: boolean;
  id: string; name: string; folder: string; coordinator: Selection; worker: Selection;
  messages: ChatMessage[]; workers: Worker[]; activity?: Activity[]; sessionId?: string; cursor: number;
  status: string; createdAt: number; turnId?: string; lastActivityAt?: number;
  connection?: 'connected' | 'reconnecting' | 'offline';
  delegations?: Record<string, { message: string; name?: string; anchorMessageId?: string; cardId?: string }>;
};
export class ProjectStore {
  projects: Project[] = [];
  selectedId: string | null = null;
  private writes = Promise.resolve();
  constructor(readonly directory: string) {}
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(await readFile(join(this.directory, 'projects.json'), 'utf8'));
      if (!Array.isArray(data.projects)) throw new Error('Invalid project store');
      this.projects = data.projects;
      this.selectedId = data.selectedId;
      for (const p of this.projects) {
        if (p.status === 'starting' || p.status === 'stopping') p.status = 'idle';
        p.connection = p.sessionId ? 'reconnecting' : undefined;
        for (const m of p.messages) if (m.delivery === 'sending') m.delivery = 'uncertain';
        p.activity ??= [];
        for (const m of p.messages) if (m.role === 'tool' && !p.activity.some(a => a.id === m.id)) {
          p.activity.push({ id: m.id, name: m.text, status: m.toolStatus || 'done', at: m.at });
        }
        p.messages = p.messages.filter(m => m.role !== 'tool' && m.role !== 'worker');
      }
      assignWorkerNames(this.projects);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  get(id: string) {
    const project = this.projects.find(p => p.id === id);
    if (!project) throw new Error('Project not found.');
    return project;
  }
  async add(folder: string, coordinator: Selection, worker: Selection) {
    const canonical = await realpath(folder);
    if (!(await stat(canonical)).isDirectory()) throw new Error('Choose a folder.');
    const existing = this.projects.find(p => p.folder === canonical);
    if (existing) { existing.removed=false; this.selectedId = existing.id; await this.save(); return existing; }
    const project: Project = { id: randomUUID(), name: basename(canonical) || canonical, folder: canonical,
      coordinator, worker, messages: [], workers: [], cursor: 0, status: 'idle', createdAt: Date.now() };
    this.projects.push(project); this.selectedId = project.id; await this.save(); return project;
  }
  save() {
    assignWorkerNames(this.projects);
    const data = JSON.stringify({ version: 1, selectedId: this.selectedId, projects: this.projects }, null, 2);
    const write = this.writes.catch(() => {}).then(async () => {
      const path = join(this.directory, 'projects.json'); const tmp = `${path}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 }); await rename(tmp, path);
    });
    this.writes = write; return write;
  }
}
