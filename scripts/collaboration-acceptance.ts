import { app, ipcMain, BrowserWindow } from 'electron';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentBrowser } from '../desktop/browser.ts';
import { PersonalAgentService } from '../desktop/service.ts';
import { selectedModel, selectedReasoning } from '../agent/lib/settings.ts';
void app.whenReady().then(async()=>{
 const root=process.env.PA_ACCEPTANCE_ROOT||await mkdtemp(join(tmpdir(),'personalagent-acceptance-')),folder=join(root,'project'),directory=join(root,'state');await mkdir(folder,{recursive:true});await mkdir(directory,{recursive:true});
 const source=resolve('.');const node=join(source,'desktop-dist/runtime/node');
 const service=new PersonalAgentService(source,node,directory,()=>{});await service.initialize();
 const selection={model:(await selectedModel()).id,reasoning:await selectedReasoning()};
 const p=await service.add(folder,selection,selection);
 const browser=new AgentBrowser(directory,source,id=>service.store.get(id),(_id,text)=>console.log('Browser: '+text),(id,worker)=>void service.browserContinue(id,worker));
 await browser.start();const host=new BrowserWindow({width:1160,height:800,show:true});browser.attach(host);
 console.log(JSON.stringify({root,folder,models:selection}));
 try{
  await service.send(p.id,process.env.PA_ACCEPTANCE_ROOT?'Finish the original request: verify Cedar Tasks with actual browser interactions for add, complete, delete and reload persistence, fix any findings collaboratively, and return a screenshot plus the HTML as file results. The browser tool now supports opening a local HTML path directly.': 'Build a small local task-board web app with add, complete, and delete tasks, persisted through reload. Use plain HTML/CSS/JS and no external dependencies. Have at least two workers collaborate on this one app, communicating about the shared data interface and coordinating edits in this single checkout. Choose their assignments yourself. Verify the combined app in the browser, including persistence. Return the HTML result and a screenshot. Do not publish anything.');
  let correction=!!process.env.PA_ACCEPTANCE_ROOT,topic=!!process.env.PA_ACCEPTANCE_ROOT,last='',ticks=0;
  for(;ticks<240;ticks++){
    await delay(2500);
    const text=p.messages.filter(m=>m.role==='assistant'||m.role==='error').at(-1)?.text||'';
    if(text&&text!==last){console.log(text.slice(-1300));last=text;}
    if(!correction&&p.workers.length>=2){correction=true;await service.send(p.id,'One correction: call the app Cedar Tasks and use a cream background with forest-green accents. Keep all the original requirements.');}
    if(correction&&!topic&&ticks>15){topic=true;await service.send(p.id,'Quick unrelated question: what is 17 times 6? Keep the app work going.');}
    if(ticks>20&&p.status==='idle'&&p.workers.length>=2&&p.workers.every(w=>['done','stopped','failed'].includes(w.status)))break;
  }
  await writeFile(join(root,'result.json'),JSON.stringify({project:p,ticks,correction,topic},null,2));
  console.log(JSON.stringify({result:join(root,'result.json'),workers:p.workers.map(w=>({id:w.id,status:w.status,task:w.task})),ticks}));
 }finally{await service.remove(p.id);await service.shutdown();await browser.close();ipcMain.removeHandler('browser-ui');app.exit();}
}).catch(error=>{console.error(error);app.exit(1);});
