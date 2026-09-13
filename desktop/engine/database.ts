import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';

export type Session = { id: string; role: 'coordinator' | 'worker'; parent: string | null; task: string; status: string; messages: ModelMessage[]; cursor: number };
export type Run = { id: string; session: string; prompt: string; status: string; kind: string };
export type EngineEvent = { type: string; data: any; meta: { id: string; at: string; deliveryIds?: string[] } };
export class EngineDatabase {
  readonly db: DatabaseSync;
  private inTransaction = false;
  constructor(path: string) {
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, role TEXT NOT NULL, parent TEXT REFERENCES sessions(id), task TEXT NOT NULL, status TEXT NOT NULL, messages TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES sessions(id), prompt TEXT NOT NULL, status TEXT NOT NULL, kind TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(session TEXT NOT NULL REFERENCES sessions(id), position INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session,position));
      CREATE TABLE IF NOT EXISTS tool_calls(id TEXT PRIMARY KEY, session TEXT NOT NULL, name TEXT NOT NULL, input TEXT NOT NULL, output TEXT, status TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_pending ON runs(session,status,created);
      CREATE TABLE IF NOT EXISTS archive(id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(session TEXT PRIMARY KEY, name TEXT, deleted INTEGER NOT NULL DEFAULT 0);
      PRAGMA user_version=2;`);
  }
  archive(session: string, messages: ModelMessage[], source: string) {
    const insert = this.db.prepare('INSERT INTO archive(session,source,message,created) VALUES(?,?,?,?)');
    this.transaction(() => { for (const message of messages) insert.run(session,source,JSON.stringify(message),Date.now()); });
  }
  history(session: string) { return this.db.prepare('SELECT id,source,message FROM archive WHERE session=? ORDER BY id').all(session).map((r:any)=>({...r,message:JSON.parse(r.message)})); }
  meta(id: string) { return this.db.prepare('SELECT name,deleted FROM metadata WHERE session=?').get(id) as {name?:string;deleted?:number}|undefined; }
  setMeta(id: string, values: {name?:string;deleted?:number}) { const old=this.meta(id); this.db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?,?)').run(id,values.name??old?.name??null,values.deleted??old?.deleted??0); }
  transaction<T>(fn: () => T): T { if(this.inTransaction)return fn(); this.db.exec('BEGIN IMMEDIATE');this.inTransaction=true;try { const out=fn();this.db.exec('COMMIT');return out; } catch(e){this.db.exec('ROLLBACK');throw e;}finally{this.inTransaction=false;} }
  session(id: string): Session {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as any;
    if (!row) throw new Error('Session not found.');
    return { ...row, messages: JSON.parse(row.messages) };
  }
  sessions(): Session[] { return (this.db.prepare('SELECT id FROM sessions').all() as {id:string}[]).map(r => this.session(r.id)); }
  create(role: Session['role'], parent: string | null, task: string, id: string = randomUUID(), messages: ModelMessage[] = [], cursor = 0) {
    this.db.prepare('INSERT OR IGNORE INTO sessions VALUES(?,?,?,?,?,?,?)').run(id, role, parent, task, 'idle', JSON.stringify(messages), cursor);
    const session=this.session(id);
    if (!this.db.prepare('SELECT id FROM archive WHERE session=? LIMIT 1').get(id) && session.messages.length) this.archive(id,session.messages,'migration');
    return session;
  }
  save(s: Session) { this.db.prepare('UPDATE sessions SET status=?,messages=?,task=? WHERE id=?').run(s.status, JSON.stringify(s.messages), s.task, s.id); }
  event(session: string, type: string, data: any, deliveryId?: string): EngineEvent {
    const e: EngineEvent = { type, data, meta: { id: `evt_${randomUUID()}`, at: new Date().toISOString(), ...(deliveryId ? { deliveryIds: [deliveryId] } : {}) } };
    this.transaction(() => {
      const {cursor} = this.session(session);
      this.db.prepare('INSERT INTO events VALUES(?,?,?)').run(session, cursor, JSON.stringify(e));
      this.db.prepare('UPDATE sessions SET cursor=cursor+1 WHERE id=?').run(session);
    });
    return e;
  }
  events(session: string, from: number): EngineEvent[] { return (this.db.prepare('SELECT body FROM events WHERE session=? AND position>=? ORDER BY position').all(session, from) as {body:string}[]).map(r => JSON.parse(r.body)); }
  enqueue(session: string, prompt: string, id: string, kind = 'user') {
    const existing = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Run | undefined;
    if (existing && (existing.session !== session || existing.prompt !== prompt)) throw new Error('Request ID was already used for a different message.');
    this.db.prepare('INSERT OR IGNORE INTO runs VALUES(?,?,?,?,?,?)').run(id, session, prompt, 'queued', kind, Date.now());
    return !existing;
  }
  next(session: string): Run | undefined { return this.db.prepare("SELECT * FROM runs WHERE session=? AND status='queued' ORDER BY created,rowid LIMIT 1").get(session) as Run | undefined; }
  runState(id: string, status: string) { this.db.prepare('UPDATE runs SET status=? WHERE id=?').run(status,id); }
  toolStart(id: string, session: string, name: string, input: unknown) { this.db.prepare('INSERT OR IGNORE INTO tool_calls VALUES(?,?,?,?,NULL,?)').run(id,session,name,JSON.stringify(input),'running'); }
  toolEnd(id: string, output: unknown) { this.db.prepare("UPDATE tool_calls SET output=?,status='completed' WHERE id=?").run(JSON.stringify(output) ?? 'null',id); }
  close() { this.db.close(); }
}
