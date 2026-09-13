import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'eve/client';
import type { Project } from './store.ts';

export type Runtime = { process: ChildProcess; client: Client; directory: string; signature: string; detach?: () => void };
async function runtimeSignature(source:string,project:Project){const code=await readFile(join(source,'desktop-dist/engine.mjs'));return JSON.stringify(['desktop-engine-v2',project.coordinator,project.worker,createHash('sha256').update(code).digest('hex')]);}
export async function prepareRuntime(source: string, directory: string, project: Project) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const original=await readFile(join(source,'agent/instructions.md'),'utf8');
  const workerInstructions=original;
  const signature=await runtimeSignature(source,project);
  const config={project,workerInstructions,signature,token:randomUUID()};
  await writeFile(join(directory,'engine-config.json'),JSON.stringify(config),{mode:0o600});
  return config;
}
async function existingRuntime(directory:string, signature:string):Promise<Runtime|undefined> {
  try {
    const saved=JSON.parse(await readFile(join(directory,'engine-runtime.json'),'utf8'));
    const client=new Client({host:`http://127.0.0.1:${saved.port}`,auth:{bearer:saved.token}});
    const res=await client.fetch('/eve/v1/health',{signal:AbortSignal.timeout(1000)});
    const health=await res.json();if(!res.ok)return;
    if(health.signature!==signature){
      stopRuntime({pid:saved.pid} as ChildProcess);
      for(let i=0;i<25;i++){try{process.kill(saved.pid,0);}catch{return;}await delay(100);}
      throw new Error('The previous agent runtime is still stopping. Try again.');
    }
    const child=Object.assign(new EventEmitter(),{pid:saved.pid,exitCode:null as number|null,signalCode:null}) as unknown as ChildProcess;
    const timer=setInterval(()=>{try{process.kill(saved.pid,0);}catch{(child as any).exitCode=1;clearInterval(timer);child.emit('exit',1);}},1000);timer.unref();
    return {process:child,client,directory,signature,detach:()=>clearInterval(timer)};
  }catch(error){if(error instanceof Error&&error.message.includes('still stopping'))throw error;return;}
}
export async function launchRuntime(source:string,node:string,directory:string,project:Project,signal?:AbortSignal):Promise<Runtime> {
  signal?.throwIfAborted();
  const signature=await runtimeSignature(source,project);
  const existing=await existingRuntime(directory,signature);if(existing)return existing;
  const config=await prepareRuntime(source,directory,project);
  signal?.throwIfAborted();
  const fd=openSync(join(directory,'server.log'),'a',0o600);
  const env={...process.env,EVE_PI_WORKDIR:project.folder};delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const child=spawn(node,[join(source,'desktop-dist/engine.mjs'),directory],{cwd:directory,env,detached:true,stdio:['ignore',fd,fd]});closeSync(fd);child.unref();
  let spawnError:Error|undefined;child.on('error',e=>{spawnError=e;});
  const deadline=AbortSignal.timeout(15_000);const startup=signal?AbortSignal.any([signal,deadline]):deadline;
  try {
    while(!startup.aborted) {
      if(spawnError||child.exitCode!==null||child.signalCode!==null)throw new Error(`The agent could not start. See ${join(directory,'server.log')}`);
      const runtime=await existingRuntime(directory,signature);
      if(runtime){runtime.detach?.();return {...runtime,process:child,detach:()=>child.removeAllListeners('exit')};}
      await delay(100,undefined,{signal:startup});
    }
    startup.throwIfAborted();throw new Error('Startup timed out.');
  }catch(error){stopRuntime(child);throw error;}
}
export function stopRuntime(child:ChildProcess) {
  if(!child.pid)return;
  try{process.kill(-child.pid,'SIGTERM');}catch{}
  const timer=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}},1500);timer.unref();
}
