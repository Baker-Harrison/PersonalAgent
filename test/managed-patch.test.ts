import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyPatch} from '../agent/lib/patch.ts';
import {runManaged,inspectManaged,stopManaged} from '../agent/lib/managed-processes.ts';
test('patch validates all files, refuses ambiguity, and preserves line endings', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eve-patch-'));
 try {
 const a=join(dir,'a'),b=join(dir,'b');await writeFile(a,'one\r\ntwo\r\n');await writeFile(b,'same\nsame\n');
 await assert.rejects(applyPatch(`*** Begin Patch\n*** Update File: ${a}\n@@\n-one\n+ONE\n*** Update File: ${b}\n@@\n-same\n+new\n*** End Patch`));
 assert.equal(await readFile(a,'utf8'),'one\r\ntwo\r\n');
 await applyPatch(`*** Begin Patch\n*** Update File: ${a}\n@@\n-one\n+ONE\n*** Delete File: ${b}\n*** Add File: ${dir}/c\n+hello\n*** End Patch`);
 assert.equal(await readFile(a,'utf8'),'ONE\r\ntwo\r\n');await assert.rejects(readFile(b));assert.equal(await readFile(join(dir,'c'),'utf8'),'hello\n');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('managed output persists beyond tail, reports exit code and ownership',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eve-log-'));const prev=process.env.EVE_PI_WORKDIR;process.env.EVE_PI_WORKDIR=dir;
 try{const r=await runManaged({command:`node -e 'console.log("EARLY");console.log("x".repeat(100000));process.exitCode=7'`,waitMs:2000,timeoutMs:5000},'test');assert.equal(r.exitCode,7);assert.equal(r.state,'exited');assert.equal(r.truncated,true);assert.ok(!r.stdout.includes('EARLY'));assert.match(await readFile(r.stdoutPath,'utf8'),/^EARLY/);await assert.rejects(inspectManaged(r.processId,'other'));}finally{if(prev===undefined)delete process.env.EVE_PI_WORKDIR;else process.env.EVE_PI_WORKDIR=prev;await rm(dir,{recursive:true,force:true});}
});
test('stop kills stubborn descendants after leader exits, and is idempotent',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eve-proc-'));const prev=process.env.EVE_PI_WORKDIR;process.env.EVE_PI_WORKDIR=dir;
 try{const r=await runManaged({command:`node -e 'process.on("SIGTERM",()=>{});setInterval(()=>{},100)' > /dev/null 2>&1 & echo $! > child.pid`,waitMs:500,timeoutMs:10000},'test');assert.equal(r.state,'running');const pid=Number(await readFile(join(dir,'child.pid'),'utf8'));await stopManaged(r.processId,'test');assert.throws(()=>process.kill(pid,0));assert.equal((await stopManaged(r.processId,'test')).state,'exited');}finally{if(prev===undefined)delete process.env.EVE_PI_WORKDIR;else process.env.EVE_PI_WORKDIR=prev;await rm(dir,{recursive:true,force:true});}
});
test('timeout and abort terminate owned commands',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eve-timeout-'));const prev=process.env.EVE_PI_WORKDIR;process.env.EVE_PI_WORKDIR=dir;
 try{const r=await runManaged({command:'sleep 20',waitMs:1000,timeoutMs:100},'test');assert.equal(r.timedOut,true);assert.equal(r.state,'exited');const c=new AbortController();const p=runManaged({command:'sleep 20',waitMs:1000,timeoutMs:5000},'test',c.signal);setTimeout(()=>c.abort(),50);await assert.rejects(p,{name:'AbortError'});}finally{if(prev===undefined)delete process.env.EVE_PI_WORKDIR;else process.env.EVE_PI_WORKDIR=prev;await rm(dir,{recursive:true,force:true});}
});
test('large output has a bounded saved log and a current tail',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eve-cap-'));const prev=process.env.EVE_PI_WORKDIR;process.env.EVE_PI_WORKDIR=dir;
 try{const r=await runManaged({command:`node -e 'process.stdout.write("x".repeat(17*1024*1024));console.log("THE_END")'`,waitMs:3000,timeoutMs:10000},'cap-test');assert.equal(r.state,'exited');assert.equal(r.exitCode,0);assert.equal(r.logTruncated,true);assert.equal((await readFile(r.stdoutPath)).length,16*1024*1024);assert.match(r.stdout,/THE_END/);}finally{if(prev===undefined)delete process.env.EVE_PI_WORKDIR;else process.env.EVE_PI_WORKDIR=prev;await rm(dir,{recursive:true,force:true});}
});
