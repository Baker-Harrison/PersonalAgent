import { BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, basename, resolve, sep, extname } from 'node:path';
import { mediaType } from './engine/files-tool.ts';

// A local origin makes relative scripts, styles, and storage work in the preview.
export async function serveWebsite(path:string,port=0) {
  if(!(await stat(path)).isFile())throw new Error('Choose a local HTML file.');
  const folder=await realpath(dirname(path));
  const server=createServer(async(req,res)=>{
    try {
      const target=await realpath(resolve(folder,'.'+decodeURIComponent(new URL(req.url!,'http://localhost').pathname)));
      if(!target.startsWith(folder+sep)){res.writeHead(403);res.end();return;}
      const mime=({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'} as Record<string,string>)[extname(target)]||mediaType(target);
      res.setHeader('Content-Type',mime);res.end(await readFile(target));
    }catch{res.writeHead(404);res.end('File not found');}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  return {server,url:origin+'/'+encodeURIComponent(basename(path))};
}
export async function previewWebsite(path:string) {
  const {server,url}=await serveWebsite(path),origin=new URL(url).origin;
  const preview=new BrowserWindow({width:980,height:740,title:basename(path),webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
  preview.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  preview.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==origin)event.preventDefault();});
  preview.once('closed',()=>server.close());
  try {await preview.loadURL(url);}catch(error){preview.destroy();throw error;}
  return preview;
}
