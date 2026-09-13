import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
export function browserTool(directory:string,projectId:string,workerId:string,signal:AbortSignal){return tool({
  description:'Use the project browser. Open an instance with a web URL or local HTML file path (served automatically), then observe and act using returned selectors. Instances share logins. Use needs_input for user sign-in, and finish when done. Handoff explicitly to another worker. Screenshot returns visual evidence.',
  inputSchema:z.object({action:z.enum(['open','list','navigate','observe','click','fill','select','press','scroll','screenshot','needs_input','handoff','finish']),id:z.string().optional(),url:z.string().optional(),label:z.string().optional(),selector:z.string().optional(),text:z.string().optional(),key:z.string().optional(),amount:z.number().optional(),to:z.string().optional()}),
  execute:async input=>{
    let broker;try{broker=JSON.parse(await readFile(join(directory,'..','..','browser-broker.json'),'utf8'));}catch{throw new Error('Open PersonalAgent to reconnect the browser.');}
    const res=await fetch(`http://127.0.0.1:${broker.port}`,{method:'POST',headers:{authorization:`Bearer ${broker.token}`,'content-type':'application/json'},body:JSON.stringify({...input,projectId,workerId}),signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
    const result=await res.json();if(!res.ok)throw new Error(result.error||'Browser unavailable');return result;
  },
  toModelOutput:({output})=>output.image?{type:'content',value:[{type:'text',text:JSON.stringify({...output,image:undefined})},{type:'image-data',data:output.image,mediaType:'image/png'}]}:{type:'json',value:output},
});}
