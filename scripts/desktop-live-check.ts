// Real provider/runtime checks in disposable projects. Consumes subscription usage.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { PersonalAgentService } from '../desktop/service.ts';
import { selectedModel, selectedReasoning } from '../agent/lib/settings.ts';

const source=resolve(process.argv[2]||'.'),node=process.argv[3]||process.execPath;
const root=await mkdtemp(join(tmpdir(),'personalagent-live-cycle-'));
const directory=join(root,'state'),aFolder=join(root,'project-a'),bFolder=join(root,'project-b');
await Promise.all([mkdir(aFolder),mkdir(bFolder)]);
const checks:string[]=[];
let service=new PersonalAgentService(source,node,directory,()=>{});
const check=(text:string)=>{checks.push(text);console.log(text);};
async function until(predicate:()=>boolean|Promise<boolean>,label:string,timeout=120000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await delay(250);}throw Error('Timed out: '+label);}
const exists=async(path:string)=>{try{await access(path);return true;}catch{return false;}};
try{
  await service.initialize();
  const choice={model:(await selectedModel()).id,reasoning:await selectedReasoning()};
  let a=await service.add(aFolder,choice,choice);
  const b=await service.add(bFolder,choice,{...choice,reasoning:'Medium'});
  const attachment=join(aFolder,'brief.txt');await writeFile(attachment,'The private test code for this project is MAPLE-731.');
  await service.send(a.id,'Read the attached original file using files and reply with the test code.',[{path:attachment,name:'brief.txt',mediaType:'text/plain'}]);
  await until(()=>a.status==='idle'&&a.messages.some(m=>m.role==='assistant'&&m.text.includes('MAPLE-731')),'attachment reading');
  check('Real attachment read and chat response passed');
  await service.select(b.id);assert.equal(service.store.selectedId,b.id);assert.equal(b.messages.length,0);assert.equal(b.worker.reasoning,'Medium');
  await service.select(a.id);
  await service.send(a.id,'Use a fresh worker to run this exact Bash command in this folder: sleep 12; printf RESUMED > completion.txt. Use waitMs 1000. Have the worker verify the file after the command finishes. Return immediately while it works.');
  await until(()=>a.workers.some(w=>w.activity?.some(t=>t.name==='bash'&&t.input?.includes('sleep 12'))),'background command start');
  const aId=a.id;
  await service.shutdown();
  service=new PersonalAgentService(source,node,directory,()=>{});await service.initialize();a=service.store.get(aId);await service.select(aId);
  await until(async()=>await exists(join(aFolder,'completion.txt'))&&a.status==='idle'&&a.workers.length>0&&a.workers.every(w=>w.status==='done'),'background completion after restart');
  assert.equal(await readFile(join(aFolder,'completion.txt'),'utf8'),'RESUMED');
  check('Background execution, app restart, durable transcript and completion reporting passed');
  const prior=a.messages.length;await service.send(a.id,'What was the test code in my attachment? Answer from our conversation without using any tool.');
  await until(()=>a.status==='idle'&&a.messages.slice(prior).some(m=>m.role==='assistant'&&m.text.includes('MAPLE-731')),'recall after restart');
  check('Conversation recall after restart passed');
  const worker=a.workers[0];await service.manageWorker(a.id,worker.id,'rename','Maple');assert.equal(worker.displayName,'Maple');
  const cursor=worker.cursor;await service.browserContinue(a.id,worker.sessionId,true);await delay(1000);assert.equal(worker.cursor,cursor);assert.equal(worker.status,'done');
  const messageCount=a.messages.length;await service.manageWorker(a.id,worker.id,'delete');await delay(2000);assert.equal(a.messages.length,messageCount);assert.ok(!a.workers.some(w=>w.id===worker.id));
  check('Worker rename and quiet completed-worker removal passed');
  await service.send(a.id,'Start a fresh worker for a cancellation test. Its only task is to run the exact Bash command sleep 30; printf BAD > should-not-exist.txt with waitMs 1000, then wait for it to finish. Return immediately.');
  await until(()=>a.workers.some(w=>w.activity?.some(t=>t.name==='bash'&&t.input?.includes('sleep 30'))),'cancellation command start');
  await service.cancel(a.id);await until(()=>a.status==='idle'&&a.workers.every(w=>['stopped','done','failed'].includes(w.status)),'cancellation settling');
  check('Cancellation settled; checking delayed side effects');
  await service.remove(b.id);assert.ok(!service.state().projects.some(p=>p.id===b.id));
  const restored=await service.add(bFolder,choice,choice);assert.equal(restored.id,b.id);assert.equal(restored.worker.reasoning,'Medium');
  check('Independent project settings, switching, removal and restoration passed');
  await delay(32000);assert.equal(await exists(join(aFolder,'should-not-exist.txt')),false);
  check('Cancelled command and descendants produced no delayed write');
  await writeFile(join(root,'result.json'),JSON.stringify({checks,projects:service.store.projects},null,2));
  console.log(JSON.stringify({root,checks:checks.length,status:'passed'}));
}catch(error){await writeFile(join(root,'failure.json'),JSON.stringify({checks,error:String(error),projects:service.store.projects},null,2));console.error('Evidence: '+root);throw error;}
finally{for(const p of service.store.projects)await service.remove(p.id).catch(()=>{});await service.shutdown();}
