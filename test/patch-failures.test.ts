import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,symlink,stat,mkdir,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyPatch} from '../agent/lib/patch.ts';
test('patch rollback restores earlier edits if a later write fails',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eve-rollback-'));
 try{const a=join(dir,'a');await writeFile(a,'original\n',{mode:0o755});await mkdir(join(dir,'blocked'),{mode:0o555});
 await assert.rejects(applyPatch(`*** Begin Patch\n*** Update File: ${a}\n@@\n-original\n+changed\n*** Add File: ${dir}/blocked/child\n+new\n*** End Patch`),/Rollback completed/);
 assert.equal(await readFile(a,'utf8'),'original\n');assert.equal((await stat(a)).mode&0o777,0o755);
 }finally{await chmod(join(dir,'blocked'),0o755).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});
test('patch refuses duplicate targets, existing additions, and symlink files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eve-patch-refuse-'));
 try{const a=join(dir,'a');await writeFile(a,'a\n');await symlink(a,join(dir,'link'));
 for(const body of [`*** Delete File: ${a}\n*** Add File: ${a}\n+b`,`*** Add File: ${a}\n+b`,`*** Update File: ${dir}/link\n@@\n-a\n+b`])await assert.rejects(applyPatch(`*** Begin Patch\n${body}\n*** End Patch`));
 assert.equal(await readFile(a,'utf8'),'a\n');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('multiple hunks keep untouched text and EOF anchors resolve repeated lines',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eve-hunks-'));
 try{const a=join(dir,'a');await writeFile(a,'repeat\nkeep\nrepeat');await applyPatch(`*** Begin Patch\n*** Update File: ${a}\n@@\n repeat\n-keep\n+kept\n@@\n-repeat\n+last\n*** End of File\n*** End Patch`);assert.equal(await readFile(a,'utf8'),'repeat\nkept\nlast');}finally{await rm(dir,{recursive:true,force:true});}
});
