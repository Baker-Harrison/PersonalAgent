import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV4 } from 'ai/test';
import { simulateReadableStream } from 'ai';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { EngineDatabase } from '../desktop/engine/database.ts';
import { ProjectEngine } from '../desktop/engine/engine.ts';
import type { Project } from '../desktop/store.ts';

const choice={model:'gpt-5.6-luna',reasoning:'Light' as const};
const finish=(tools=false):LanguageModelV4StreamPart=>({type:'finish',finishReason:{unified:tools?'tool-calls':'stop',raw:tools?'toolUse':'stop'},usage:{inputTokens:{total:20,noCache:20,cacheRead:0,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}}});
const words=(text:string):LanguageModelV4StreamPart[]=>[{type:'text-start',id:'text'},...text.split(' ').map(text=>({type:'text-delta' as const,id:'text',delta:text+' '})),{type:'text-end',id:'text'}];
async function until(fn:()=>boolean){for(let i=0;i<400;i++){if(fn())return;await delay(10);}assert.fail('Engine did not settle');}

test('coordinator streams before tools, workers run independently, and completion wakes coordinator',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'engine-loop-'));const previous=process.env.EVE_PI_WORKDIR;process.env.EVE_PI_WORKDIR=dir;
  const db=new EngineDatabase(join(dir,'work.sqlite'));
  let coordinatorCalls=0,workerCalls=0;
  const engine=new ProjectEngine(db,{folder:dir,coordinator:choice,worker:choice} as Project,dir,'Use Bash to inspect the project.',role=>new MockLanguageModelV4({doStream:async()=>{
    let chunks:LanguageModelV4StreamPart[];
    if(role==='coordinator'&&coordinatorCalls++===0)chunks=[...words('I will check now'),{type:'tool-call',toolCallId:'create-1',toolName:'create_agent',input:JSON.stringify({task:'Print MARKER using Bash'})},finish(true)];
    else if(role==='worker'&&workerCalls++===0)chunks=[...words('Reading the project'),{type:'tool-call',toolCallId:'bash-1',toolName:'bash',input:JSON.stringify({command:'sleep 0.2; printf MARKER'})},finish(true)];
    else chunks=[...words(role==='worker'?'Found MARKER':'The worker is done'),finish()];
    return{stream:simulateReadableStream({chunks,chunkDelayInMs:8})};
  }}));
  try{
    const id=engine.create('Check the folder','user-1');
    await until(()=>db.events(id,0).some(e=>e.type==='message.appended'));
    assert.ok(!db.events(id,0).some(e=>e.type==='turn.completed'),'Text must be observable before the turn finishes');
    await until(()=>db.sessions().some(s=>s.role==='worker'));
    engine.send(id,'A follow-up while the worker runs','user-2');
    await until(()=>!!db.db.prepare("SELECT id FROM runs WHERE kind='worker' AND status='completed'").get());
    const parentEvents=db.events(id,0);const types=parentEvents.map(e=>e.type);
    assert.ok(types.indexOf('message.appended')<types.indexOf('actions.requested'));
    assert.ok(types.indexOf('actions.requested')<types.indexOf('subagent.called'));
    assert.equal(db.sessions().filter(s=>s.role==='worker').length,1);
    assert.equal(db.db.prepare("SELECT status FROM tool_calls WHERE id='bash-1'").get()?.status,'completed');
    assert.ok(parentEvents.some(e=>e.type==='message.received'&&e.data.source==='worker'));
    engine.send(id,'Check the folder','user-1');
    assert.equal(db.db.prepare("SELECT count(*) AS n FROM runs WHERE id='user-1'").get()?.n,1);
    assert.equal(parentEvents.filter(e=>e.type==='message.received'&&e.data.message==='Check the folder').length,1);
    const header=(await readFile(join(dir,'work.sqlite'))).subarray(0,16).toString();assert.equal(header,'SQLite format 3\0');
  }finally{await engine.shutdown();if(previous===undefined)delete process.env.EVE_PI_WORKDIR;else process.env.EVE_PI_WORKDIR=previous;await rm(dir,{recursive:true,force:true});}
});

test('recovery preserves completed effects and never automatically replays an interrupted tool',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'engine-recover-'));
  let db=new EngineDatabase(join(dir,'work.sqlite'));const s=db.create('worker',null,'Edit once','worker');
  db.enqueue(s.id,'Edit once','run');db.runState('run','running');db.toolStart('edit',s.id,'bash',{command:'edit file'});db.close();
  db=new EngineDatabase(join(dir,'work.sqlite'));let calls=0;
  const engine=new ProjectEngine(db,{folder:dir,coordinator:choice,worker:choice} as Project,dir,'',()=>new MockLanguageModelV4({doStream:async({prompt})=>{calls++;assert.match(JSON.stringify(prompt),/uncertain outcome/);return {stream:simulateReadableStream({chunks:[...words('Inspected saved effects; no replay needed'),finish()]})};}}));
  try{engine.restore();await until(()=>db.session(s.id).status==='done');assert.equal(calls,1);assert.match(JSON.stringify(db.session(s.id).messages),/uncertain outcome/);assert.equal(db.events(s.id,0)[0].type,'turn.failed');}
  finally{await engine.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('Stop all work aborts a running worker without starting a completion turn',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'engine-stop-'));
  const db=new EngineDatabase(join(dir,'work.sqlite'));
  const parent=db.create('coordinator',null,'','parent');
  const child=db.create('worker',parent.id,'Wait','child');
  const engine=new ProjectEngine(db,{folder:dir,coordinator:choice,worker:choice} as Project,dir,'',()=>new MockLanguageModelV4({doStream:async({abortSignal})=>({stream:new ReadableStream({start(controller){ controller.enqueue({type:'text-start',id:'text'});controller.enqueue({type:'text-delta',id:'text',delta:'Working'});abortSignal?.addEventListener('abort',()=>controller.close(),{once:true}); }})})}));
  try {
    engine.send(child.id,'Wait','run');
    await until(()=>db.events(child.id,0).some(e=>e.type==='message.appended'));
    engine.send(child.id,'Queued follow-up','queued');
    assert.equal(engine.cancel(parent.id,true),true);
    await until(()=>db.session(child.id).status==='stopped');
    assert.equal(db.db.prepare("SELECT status FROM runs WHERE id='queued'").get()?.status,'cancelled');
    assert.equal(db.db.prepare("SELECT count(*) AS n FROM runs WHERE kind='worker'").get()?.n,0);
    assert.ok(db.events(child.id,0).some(e=>e.type==='turn.cancelled'));
  }finally{await engine.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('concurrent workers exchange messages, wake peers, and preserve an independent archive', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'engine-peers-')),db=new EngineDatabase(join(dir,'work.sqlite'));
  const parent=db.create('coordinator',null,'','parent');
  const engine=new ProjectEngine(db,{folder:dir,coordinator:choice,worker:choice} as Project,dir,'',()=>new MockLanguageModelV4({doStream:async()=>({stream:simulateReadableStream({chunks:[...words('Ready for collaboration'),finish()],chunkDelayInMs:20})})}));
  const signal=new AbortController().signal;
  const call=async(session:any,name:string,input:any,id:string)=> (engine as any).tools(session,'run',signal)[name].execute(input,{toolCallId:id});
  try {
    await call(parent,'create_agent',{task:'Build shared data interface'},'a');
    await call(parent,'create_agent',{task:'Build UI consuming the interface'},'b');
    assert.equal(db.sessions().filter(s=>s.role==='worker').length,2);
    const a=db.session('agent_a');
    await call(a,'send_to_agent',{agentId:'agent_b',message:'Use records with id and title',delivery:'queue'},'handoff');
    await until(()=>db.db.prepare("SELECT status FROM runs WHERE id='dispatch_handoff'").get()?.status==='completed');
    assert.ok(db.db.prepare("SELECT id FROM runs WHERE kind='worker' AND prompt LIKE '%No Bash, browser, or file tools ran%'").get(),'Coordinator must receive the lack of execution evidence');
    assert.match(JSON.stringify(db.history('agent_b')),/id and title/);
    const b=db.session('agent_b');b.messages=[];db.save(b);
    assert.match(JSON.stringify(db.history('agent_b')),/id and title/);
    const inspection=await call(a,'inspect_agents',{recentMessages:0},'inspect');assert.equal(inspection.length,1);assert.equal(inspection[0].agentId,'agent_b');
    await assert.rejects(call(a,'inspect_agents',{agentId:a.id,recentMessages:30},'self-inspect'),/own agent ID/);
    engine.manageWorker(a.id,'rename','Maya');assert.equal(db.meta(a.id)?.name,'Maya');
    engine.manageWorker(a.id,'delete');assert.throws(()=>engine.send(a.id,'Resume','resurrect'),/deleted/);
  } finally {await engine.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('compaction preserves archive and restores a usable session after summary failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'engine-compact-')),db=new EngineDatabase(join(dir,'work.sqlite'));
 const original=Array.from({length:12},(_,i)=>({role:i%2?'assistant' as const:'user' as const,content:'Decision '+i}));
 const s=db.create('coordinator',null,'','parent',original);let fail=true;
 const engine=new ProjectEngine(db,{folder:dir,coordinator:choice,worker:choice} as Project,dir,'',()=>new MockLanguageModelV4({doStream:async()=>({stream:simulateReadableStream({chunks:[...words('Continued'),finish()]})})}),{budget:1,summarize:async()=>{if(fail)throw Error('summary failed');return 'Preserve Decision 4';}});
 try{
  engine.send(s.id,'Continue','one');await until(()=>db.db.prepare("SELECT status FROM runs WHERE id='one'").get()?.status==='failed');
  assert.ok(db.events(s.id,0).some(e=>e.type==='context.failed'));assert.match(JSON.stringify(db.session(s.id).messages),/Decision 0/);
  fail=false;engine.send(s.id,'Retry','two');await until(()=>db.db.prepare("SELECT status FROM runs WHERE id='two'").get()?.status==='completed');
  assert.ok(db.events(s.id,0).some(e=>e.type==='context.compacted'));assert.match(JSON.stringify(db.history(s.id)),/Decision 0/);
 }finally{await engine.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('deleting a completed worker does not wake the coordinator or lose its archive',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'engine-delete-done-')),db=new EngineDatabase(join(dir,'work.sqlite'));
  const parent=db.create('coordinator',null,'','parent'),child=db.create('worker',parent.id,'Completed task','child');
  child.status='done';db.save(child);db.archive(child.id,[{role:'assistant',content:'Saved result'}],'worker');
  const engine=new ProjectEngine(db,{folder:dir,coordinator:choice,worker:choice} as Project,dir,'');
  try{engine.manageWorker(child.id,'delete');assert.equal(db.next(parent.id),undefined);assert.match(JSON.stringify(db.history(child.id)),/Saved result/);assert.equal(db.meta(child.id)?.deleted,1);}
  finally{await engine.shutdown();await rm(dir,{recursive:true,force:true});}
});
