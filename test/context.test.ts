import test from 'node:test';
import assert from 'node:assert/strict';
import { compactable } from '../desktop/engine/context.ts';
import type { ModelMessage } from 'ai';
test('compaction triggers only at threshold and preserves complete tool sequences',()=>{
 const messages:ModelMessage[]=[{role:'user',content:'Old task '.repeat(200)}, {role:'assistant',content:[{type:'tool-call',toolCallId:'a',toolName:'bash',input:{command:'pwd'}}]}, {role:'tool',content:[{type:'tool-result',toolCallId:'a',toolName:'bash',output:{type:'text',value:'/project'}}]},...Array.from({length:8},(_,i)=>({role:i%2?'assistant' as const:'user' as const,content:'Recent '+i}))];
 assert.equal(compactable(messages,100000),0);const split=compactable(messages,10);assert.ok(split>=3);assert.equal(messages[split].role,'user');assert.ok(messages.slice(split).length>=6);
});

test('a single long worker turn can compact at a completed tool boundary',()=>{
 const messages:ModelMessage[]=[{role:'user',content:'Keep building'},...Array.from({length:10},(_,i)=>[{role:'assistant' as const,content:[{type:'tool-call' as const,toolCallId:String(i),toolName:'bash',input:{}}]},{role:'tool' as const,content:[{type:'tool-result' as const,toolCallId:String(i),toolName:'bash',output:{type:'text' as const,value:'Step result '.repeat(200)}}]}]).flat()];
 const split=compactable(messages,20);assert.ok(split>0);assert.equal(messages[split].role,'assistant');assert.equal(messages[split-1].role,'tool');
});
