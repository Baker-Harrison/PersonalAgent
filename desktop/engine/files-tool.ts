import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
export const mediaType=(path:string)=>({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.pdf':'application/pdf','.html':'text/html','.txt':'text/plain','.md':'text/markdown','.json':'application/json'}[extname(path).toLowerCase()]||'application/octet-stream');
export function filesTool(folder:string,present:(files:any[])=>void){return tool({
  description:'Inspect local files or present verified results in the main conversation. Images are visible to you. Paths refer to originals. Use Bash for editing and extracting unsupported document formats.',
  inputSchema:z.object({paths:z.array(z.string()).min(1).max(20),present:z.boolean().default(false)}),
  execute:async({paths,present:publish})=>{
    const files=await Promise.all(paths.map(async value=>{const path=resolve(folder,value),info=await stat(path);if(!info.isFile())throw new Error('Choose a file');const mime=mediaType(path);let text,image;if(info.size<=12_000_000){if(mime.startsWith('image/'))image=(await readFile(path)).toString('base64');else if(mime.startsWith('text/')||/\.(json|js|ts|tsx|css|csv|svg)$/.test(path))text=(await readFile(path,'utf8')).slice(0,30000);}return {path,name:basename(path),size:info.size,mediaType:mime,text,image};}));
    if(publish)present(files.map(({image,text,...file})=>file));return {files};
  },
  toModelOutput:({output})=>({type:'content',value:output.files.flatMap(file=>[{type:'text' as const,text:JSON.stringify({...file,image:undefined})},...(file.image?[{type:'image-data' as const,data:file.image,mediaType:file.mediaType}]:[])])}),
});}
