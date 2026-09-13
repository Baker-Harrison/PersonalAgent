import { createServer, type ServerResponse } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { ModelMessage } from 'ai';
import { EngineDatabase, type EngineEvent } from './database.ts';
import { ProjectEngine } from './engine.ts';
import type { Project } from '../store.ts';

export async function startServer(directory: string) {
  const config = JSON.parse(await readFile(join(directory,'engine-config.json'),'utf8')) as { project:Project; workerInstructions:string; token:string; signature:string };
  const db=new EngineDatabase(join(directory,'work.sqlite'));
  const p=config.project;
  if(p.sessionId) {
    const history=p.messages.filter(m=>m.role==='user'||m.role==='assistant').map(m=>({role:m.role,content:m.text})) as ModelMessage[];
    db.create('coordinator',null,'',p.sessionId,history,p.cursor);
    for(const w of p.workers) {
      const child=db.create('worker',p.sessionId,w.task,w.sessionId,[{role:'user',content:w.task},{role:'assistant',content:w.output||'Previous task ended.'}],w.cursor);
      if(child.status==='idle'){child.status=w.status;db.save(child);}
    }
  }
  const engine=new ProjectEngine(db,p,directory,config.workerInstructions);
  const streams=new Set<ServerResponse>();
  const server=createServer(async(req,res)=>{
    const json=(status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
    const auth=Buffer.from(req.headers.authorization??''),expected=Buffer.from(`Bearer ${config.token}`);
    if(auth.length!==expected.length||!timingSafeEqual(auth,expected)){json(401,{error:'Unauthorized'});return;}
    try {
      const url=new URL(req.url!,'http://127.0.0.1');
      if(req.method==='GET'&&url.pathname==='/eve/v1/health'){json(200,{ok:true,status:'ready',workflowId:'personalagent-local-v1',projectId:p.id,signature:config.signature});return;}
      if(req.method==='POST'&&url.pathname==='/agents/manage'){
        let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4096)throw new Error('Request too large');}
        const body=JSON.parse(raw);if(!['rename','delete'].includes(body.action))throw new Error('Unknown action');
        engine.manageWorker(body.id,body.action,body.name);json(200,{ok:true});return;
      }
      const match=url.pathname.match(/^\/eve\/v1\/session(?:\/([^/]+))?(?:\/(stream|cancel))?$/);
      if(!match){json(404,{error:'Not found'});return;}
      const id=match[1]?decodeURIComponent(match[1]):undefined;
      if(id)db.session(id);
      if(req.method==='GET'&&id&&match[2]==='stream') {
        const from=Number(url.searchParams.get('startIndex')??0);
        if(!Number.isSafeInteger(from)||from<0){json(400,{error:'Invalid cursor'});return;}
        const tail=db.session(id).cursor-1;
        res.writeHead(200,{'content-type':'application/x-ndjson','x-eve-stream-version':'25','x-eve-stream-tail-index':String(tail),'cache-control':'no-store'});
        res.flushHeaders();res.write('\n');
        for(const event of db.events(id,from))res.write(JSON.stringify(event)+'\n');
        if(url.searchParams.has('includeTailIndex')){res.end();return;}
        const listener=(event:EngineEvent)=>{if(res.writableLength>1024*1024){res.destroy();return;}res.write(JSON.stringify(event)+'\n');};
        engine.events.on(id,listener);streams.add(res);
        const timer=setInterval(()=>res.write('\n'),5000);
        res.once('close',()=>{clearInterval(timer);engine.events.off(id,listener);streams.delete(res);});return;
      }
      if(req.method!=='POST'){json(405,{error:'Method not allowed'});return;}
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1_000_000){json(413,{error:'Message too large'});return;}}
      const body=JSON.parse(raw||'{}');
      if(id&&match[2]==='cancel'){const active=engine.cancel(id,body.tasks===true);json(200,active?{ok:true,status:'accepted',sessionId:id}:{ok:true,status:'no_active_turn'});return;}
      if(typeof body.message!=='string'||!body.message.trim()||body.message.length>100_000){json(400,{error:'Enter a message under 100,000 characters.'});return;}
      const requestId=typeof req.headers['x-request-id']==='string'?req.headers['x-request-id']:randomUUID();
      const sessionId=id??engine.create(body.message,requestId);
      if(id)engine.send(id,body.message,requestId);
      json(202,{sessionId,deliveryId:requestId});
    }catch(error){json(400,{error:error instanceof Error?error.message:'Request failed'});}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port;
  await writeFile(join(directory,'engine-runtime.json'),JSON.stringify({pid:process.pid,port,token:config.token,signature:config.signature}),{mode:0o600});
  engine.restore();
  console.log(JSON.stringify({event:'engine.ready',port,projectId:p.id}));
  let closed=false;
  const close=async()=>{if(closed)return;closed=true;for(const stream of streams)stream.end();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await engine.shutdown();};
  return {engine,server,close};
}
if(process.argv[2]) {
  const running=await startServer(process.argv[2]);
  const close=()=>void running.close().finally(()=>process.exit(0));
  process.once('SIGTERM',close);process.once('SIGINT',close);
}
