import { generateText, type LanguageModel, type ModelMessage } from 'ai';

// Compact at conversation or completed tool-step boundaries, keeping call/result pairs together.
export function compactable(messages: ModelMessage[], budget: number, overhead = 0) {
  const estimate = Math.ceil((JSON.stringify(messages, (key,value)=>key==='providerOptions'||key==='providerMetadata'?undefined:['data','image'].includes(key)&&typeof value==='string'&&value.length>1000?'[image: '+ ' '.repeat(6000)+']':value).length + overhead) / 3);
  if (estimate < budget) return 0;
  for (let i=messages.length-6;i>0;i--) if(messages[i]?.role==='user'||(messages[i]?.role==='assistant'&&messages[i-1]?.role==='tool')) return i;
  return 0;
}
export async function summarize(model: LanguageModel, messages: ModelMessage[], signal: AbortSignal) {
  const result=await generateText({model,abortSignal:signal,prompt:
    'Summarize this conversation for continuation. Preserve active objectives, latest corrections, unresolved work, agent IDs, original file paths, and decisions. Distinguish tentative ideas from decisions. Keep it concise; do not perform the task. Original messages remain available through search_conversation.\n'+JSON.stringify(messages,(key,value)=>key==='providerOptions'||key==='providerMetadata'?undefined:['data','image'].includes(key)&&typeof value==='string'&&value.length>1000?'[image retained in original history]':value)});
  if(!result.text.trim())throw new Error('Empty summary');
  return result.text;
}
