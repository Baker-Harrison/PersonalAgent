import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import bash from '../agent/tools/bash.ts';
const ctx={session:{id:'compact-bash-tests'}} as Parameters<typeof bash.execute>[1];
async function execute(input: Parameters<typeof bash.execute>[0], context: Parameters<typeof bash.execute>[1] = ctx): Promise<Record<string, unknown>> { return await bash.execute(input, context) as Record<string, unknown>; }
test('Bash omits routine metadata and exposes full output only when needed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eve-compact-test-'));const previous=process.env.EVE_PI_WORKDIR;process.env.EVE_PI_WORKDIR=dir;
 try{
 const short=await execute({command:'printf hello'},ctx);assert.deepEqual(short,{state:'exited',exitCode:0,stdout:'hello'});
 const long=await execute({command:`node -e 'console.log("EARLY");console.log("x".repeat(4000))'`},ctx);assert.equal(long.truncated,true);assert.equal(long.stdout,undefined);assert.match(await readFile(String(long.stdoutPath),'utf8'),/^EARLY/);assert.equal(long.stderrPath,undefined);
 }finally{if(previous===undefined)delete process.env.EVE_PI_WORKDIR;else process.env.EVE_PI_WORKDIR=previous;await rm(dir,{recursive:true,force:true});}
});
test('one Bash tool starts, inspects, finds logs and stops an owned process',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eve-compact-process-'));const previous=process.env.EVE_PI_WORKDIR;process.env.EVE_PI_WORKDIR=dir;
 try{const running=await execute({command:'sleep 10',waitMs:0},ctx);assert.equal(running.state,'running');const processId=String(running.processId);
 assert.equal((await execute({operation:'status',processId},ctx)).state,'running');
 await assert.rejects(execute({operation:'stop',processId},{session:{id:'other'}} as typeof ctx));
 const logs=await execute({operation:'logs',processId},ctx);assert.ok(logs.stdoutPath&&logs.stderrPath);
 assert.equal((await execute({operation:'stop',processId,workingDirectory:dir,maxRuntimeMs:1000},ctx)).state,'exited');assert.equal((await execute({operation:'status',processId},ctx)).state,'exited');
 await assert.rejects(execute({operation:'stop',processId,command:'touch forbidden'},ctx));await assert.rejects(execute({},ctx));
 }finally{if(previous===undefined)delete process.env.EVE_PI_WORKDIR;else process.env.EVE_PI_WORKDIR=previous;await rm(dir,{recursive:true,force:true});}
});

test('return delay does not terminate the command; lifetime does', async () => {
 const running = await execute({command:'sleep 10',waitMs:20,maxRuntimeMs:300});
 assert.equal(running.state,'running');
 const ended = await execute({operation:'status',processId:String(running.processId),waitMs:2000});
 assert.equal(ended.state,'exited'); assert.equal(ended.timedOut,true);
});

test('Bash can read and exactly edit files without file-specific tools', async () => {
 const dir = await mkdtemp(join(tmpdir(),'eve-bash-files-'));
 try {
  const result = await execute({workingDirectory:dir,command:`node --input-type=module -e 'import fs from "node:fs";fs.mkdirSync("nested");fs.writeFileSync("nested/test.txt", "before alpha after");const old=fs.readFileSync("nested/test.txt","utf8");if(old.split("alpha").length!==2)throw Error("ambiguous");fs.writeFileSync("nested/test.txt",old.replace("alpha",()=>"$&"));console.log(fs.readFileSync("nested/test.txt","utf8"));'`});
  assert.equal(result.exitCode,0); assert.equal(result.stdout,'before $& after\n');
  assert.equal(await readFile(join(dir,'nested/test.txt'),'utf8'),'before $& after');
 } finally { await rm(dir,{recursive:true,force:true}); }
});
