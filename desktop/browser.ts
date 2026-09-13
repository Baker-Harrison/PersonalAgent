import { serveWebsite } from './preview.ts';
import { BrowserWindow, WebContentsView, ipcMain, session, nativeImage } from 'electron';
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';

type Instance = { id:string; projectId:string; workerId:string; folder:string; label:string; view:WebContentsView; needsInput?:string; inspected?:boolean; busy?:boolean; finished?:boolean; localPath?:string; server?:ReturnType<typeof createServer> };
export class AgentBrowser {
  private instances = new Map<string,Instance>();
  private window?:BrowserWindow;
  private chrome?:WebContentsView;
  private visible=false;
  private bounds?:Electron.Rectangle;
  private selected?:string;
  private expanded=false;
  private normalBounds?:Electron.Rectangle;
  private server=createServer();
  private token=randomUUID();
  private writes=Promise.resolve();
  private restoring=false;
  constructor(private directory:string,private source:string,private project:(id:string)=>{folder:string;removed?:boolean},private notify:(projectId:string,text:string)=>void,private resume:(projectId:string,workerId:string,restoring?:boolean)=>void) {}
  async start() {
    await mkdir(this.directory,{recursive:true});
    this.server.on('request',async(req,res)=>{
      const expected=Buffer.from(`Bearer ${this.token}`),actual=Buffer.from(req.headers.authorization||'');
      if(expected.length!==actual.length||!timingSafeEqual(expected,actual)){res.writeHead(401);res.end();return;}
      try{
        let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1_000_000)throw new Error('Browser request too large');}
        const input=JSON.parse(raw); const result=await this.command(input);
        res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
      }catch(e){res.writeHead(400);res.end(JSON.stringify({error:e instanceof Error?e.message:String(e)}));}
    });
    await new Promise<void>(resolve=>this.server.listen(0,'127.0.0.1',resolve));
    const port=(this.server.address() as {port:number}).port;
    await writeFile(join(this.directory,'browser-broker.json'),JSON.stringify({port,token:this.token}),{mode:0o600});
    const browserSession=session.fromPartition('persist:personalagent-browser');
    browserSession.on('will-download',(_event,item,contents)=>{
      const instance=[...this.instances.values()].find(i=>i.view.webContents===contents);if(!instance){item.cancel();return;}
      const path=join(instance.folder,`${randomUUID().slice(0,8)}-${basename(item.getFilename())}`);item.setSavePath(path);
      item.once('done',(_event,state)=>{this.notify(instance.projectId,state==='completed'?`Browser downloaded ${path}`:'Browser download did not finish.');});
    });
    ipcMain.handle('browser-ui',async(event,action:string,id?:any)=>{
      if(event.sender!==this.chrome?.webContents)throw new Error('Unknown browser window');
      if(action==='state')return this.state();
      if(action==='select'&&id&&this.instances.has(id)){this.selected=id;this.layout();}
      if(action==='expand'){this.expanded=!this.expanded;const i=this.instances.get(this.selected!);if(i)i.inspected=this.expanded;this.resize();}
      if(action==='minimize'){this.visible=false;this.layout();}
      if(action==='move'&&this.bounds){this.bounds.x+=Number(id.x)||0;this.bounds.y+=Number(id.y)||0;this.layout();}
      if(action==='resize'&&this.bounds&&!this.expanded){this.bounds.width+=Number(id.x)||0;this.bounds.height+=Number(id.y)||0;this.layout();}
      if(action==='continue')await this.continueSelected();
      return this.state();
    });
  }
  state(){return {selected:this.selected,expanded:this.expanded,instances:[...this.instances.values()].map(i=>({id:i.id,label:i.label,needsInput:i.needsInput}))};}
  attach(window?:BrowserWindow){
    if(this.window){for(const view of [this.chrome,...[...this.instances.values()].map(i=>i.view)])if(view)try{this.window.contentView.removeChildView(view);}catch{}}
    this.window=window;this.layout();
  }
  private open(){
    if(this.chrome&&!this.chrome.webContents.isDestroyed())return;
    this.chrome=new WebContentsView({webPreferences:{preload:join(this.source,'desktop-dist/browser-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    this.chrome.setBackgroundColor('#00000000');
    void this.chrome.webContents.loadFile(join(this.source,'desktop/ui/browser.html'));
  }
  private resize(){
    if(this.expanded){if(this.bounds)this.normalBounds??={...this.bounds};}
    else if(this.normalBounds){this.bounds=this.normalBounds;this.normalBounds=undefined;}
    this.visible=true;this.layout();
  }
  private layout(){
    if(!this.window||this.window.isDestroyed())return;
    for(const view of [this.chrome,...[...this.instances.values()].map(i=>i.view)])if(view)try{this.window.contentView.removeChildView(view);}catch{}
    if(!this.visible)return;
    this.open();
    const [width,height]=this.window.getContentSize();
    this.bounds??={x:width-464,y:height-390,width:448,height:340};
    const b=this.bounds;
    if(this.expanded){b.x=24;b.y=64;b.width=width-48;b.height=height-88;}
    b.width=Math.min(width-24,Math.max(320,b.width));b.height=Math.min(height-76,Math.max(240,b.height));
    b.x=Math.round(Math.max(12,Math.min(width-b.width-12,b.x)));b.y=Math.round(Math.max(52,Math.min(height-b.height-12,b.y)));
    const selected=this.instances.get(this.selected!);
    if(selected){this.window.contentView.addChildView(selected.view);selected.view.setBorderRadius(16);selected.view.setBounds({x:b.x+6,y:b.y+6,width:b.width-12,height:b.height-12});}
    const controls=selected?.needsInput?{x:b.x+12,y:b.y+b.height-116,width:b.width-24,height:108}:{x:b.x+b.width-194,y:b.y+b.height-66,width:188,height:60};
    this.window.contentView.addChildView(this.chrome!);this.chrome!.setBounds(controls);
    this.chrome!.webContents.send('browser-state',this.state());
  }
  relayout(){this.layout();}
  async command(input:any):Promise<any>{
    const {projectId,workerId,action}=input;
    const project=this.project(projectId);if(project.removed)throw new Error('Project was removed.');
    if(typeof workerId!=='string')throw new Error('Worker identity required');
    if(action==='list')return {instances:[...this.instances.values()].filter(i=>i.projectId===projectId).map(i=>({id:i.id,label:i.label,workerId:i.workerId,needsInput:i.needsInput,finished:i.finished,url:i.localPath||i.view.webContents.getURL()}))};
    if(action==='open'){
      let target=input.url||'about:blank',localPath:string|undefined,hosted:Awaited<ReturnType<typeof serveWebsite>>|undefined;
      if(!/^(https?:|about:)/.test(target)){
        localPath=target.startsWith('file:')?fileURLToPath(target):resolve(project.folder,target);
        hosted=await serveWebsite(localPath,input.restoreId?input.localPort:0);target=hosted.url;
      }
      target=this.url(target);
      this.open();
      const view=new WebContentsView({webPreferences:{partition:'persist:personalagent-browser',contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
      const id=input.restoreId||randomUUID(),instance:Instance={id,projectId,workerId,folder:project.folder,label:input.label||'Browser task',view,localPath,server:hosted?.server};
      this.instances.set(id,instance);
      view.webContents.setWindowOpenHandler(({url})=>{try{void view.webContents.loadURL(this.url(url)).catch(()=>{});}catch{}return {action:'deny'};});
      const current=this.instances.get(this.selected!);
      if(!current||(!current.inspected&&!current.needsInput))this.selected=id;
      view.setBounds({x:0,y:52,width:980,height:688});
      this.visible=true;this.layout();
      try{await view.webContents.loadURL(this.url(target));}catch(error){await this.save();return {id,error:String(error),message:'Inspect this instance or navigate again. For a local app URL, start its server and verify readiness first. You can also open a local HTML file path directly.'};}
      await this.save();return {id,...await this.observe(instance)};
    }
    const i=this.instances.get(input.id);if(!i||i.projectId!==projectId)throw new Error('Browser instance unavailable. List instances and inspect state before continuing; a previous submission may have completed.');
    if(i.workerId!==workerId)throw new Error('Ask the owning worker to hand off this browser.');
    if(action==='handoff'){if(typeof input.to!=='string')throw new Error('Recipient required');i.workerId=input.to;await this.save();return {id:i.id,workerId:i.workerId};}
    if(action==='finish'){i.finished=true;await this.save();if(!i.inspected&&!i.needsInput&&this.selected===i.id){this.visible=false;this.layout();}return {kept:true};}
    if(action==='needs_input'){i.needsInput=input.text||'Please sign in to continue.';this.selected=i.id;this.expanded=true;this.resize();this.notify(projectId,i.needsInput!);await this.save();return {waiting:true};}
    i.finished=false;
    if(i.needsInput)return {waiting:true,message:i.needsInput};
    if(i.busy)throw new Error('This browser is completing another action.');
    i.busy=true;
    try{
      const wc=i.view.webContents;
      if(action==='navigate'){
        const previousOrigin=new URL(wc.getURL()).origin;
        await wc.loadURL(this.url(input.url));
        if(new URL(wc.getURL()).origin!==previousOrigin){i.localPath=undefined;i.server?.close();i.server=undefined;}
      }
      else if(action==='click'||action==='fill'||action==='select') {
        await wc.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(input.selector)});if(!e)throw Error('Element not found');${action==='click'?'e.click();':action==='select'?`e.value=${JSON.stringify(input.text||'')};e.dispatchEvent(new Event('change',{bubbles:true}));`:`e.focus();const setter=Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')?.set;if(setter)setter.call(e,${JSON.stringify(input.text||'')});else e.textContent=${JSON.stringify(input.text||'')};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));`}})()`);
      }else if(action==='press'){wc.sendInputEvent({type:'keyDown',keyCode:input.key});wc.sendInputEvent({type:'keyUp',keyCode:input.key});}
      else if(action==='scroll')await wc.executeJavaScript(`window.scrollBy(0,${Number(input.amount)||500})`);
      else if(action==='screenshot'){if(!wc.debugger.isAttached())wc.debugger.attach('1.3');const shot=await wc.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});const image=nativeImage.createFromBuffer(Buffer.from(shot.data,'base64'));const path=join(project.folder,`browser-${i.id}-${Date.now()}.png`);await writeFile(path,image.toPNG());return {id:i.id,path,image: image.toPNG().toString('base64')};}
      else if(action!=='observe')throw new Error('Unknown browser action');
      await this.save();return {id:i.id,...await this.observe(i)};
    } finally{i.busy=false;}
  }
  private url(value:string){if(value==='about:blank')return value;const url=new URL(value);if(!['https:','http:'].includes(url.protocol))throw new Error('Use an HTTP or HTTPS URL');return url.href;}
  private async observe(i:Instance){
    const page=await i.view.webContents.executeJavaScript(`(()=>{const elements=[...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')].filter(e=>e.getClientRects().length);return {title:document.title,text:document.body?.innerText.slice(0,18000),elements:elements.slice(0,150).map((e,n)=>{const id='pa-'+n;e.setAttribute('data-pa',id);return {selector:'[data-pa="'+id+'"]',tag:e.tagName,label:e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder')||e.getAttribute('name'),type:e.getAttribute('type')};})};})()`);
    return {url:i.view.webContents.getURL(),...page};
  }
  private save(){
    if(this.restoring)return Promise.resolve();
    const data=JSON.stringify([...this.instances.values()].map(i=>({id:i.id,projectId:i.projectId,workerId:i.workerId,label:i.label,needsInput:i.needsInput,finished:i.finished,url:i.localPath||i.view.webContents.getURL(),localPort:i.server?(i.server.address() as {port:number})?.port:undefined})));
    const path=join(this.directory,'browser-instances.json');
    this.writes=this.writes.catch(()=>{}).then(async()=>{await writeFile(path+'.tmp',data,{mode:0o600});await rename(path+'.tmp',path);});
    return this.writes;
  }
  async restore(){
    this.restoring=true;
    try{const saved=JSON.parse(await readFile(join(this.directory,'browser-instances.json'),'utf8'));for(const i of saved){try{await this.command({...i,restoreId:i.id,action:'open'});const restored=this.instances.get(i.id);if(restored){restored.needsInput=i.needsInput;restored.finished=i.finished;}if(!i.needsInput&&!i.finished)this.resume(i.projectId,i.workerId,true);}catch{}}}catch{}
    this.restoring=false;await this.save();
    const waiting=[...this.instances.values()].find(i=>i.needsInput);if(waiting){this.selected=waiting.id;this.expanded=true;this.resize();}else {this.visible=false;this.layout();}
  }
  async continueSelected(){const i=this.instances.get(this.selected!);if(!i)return;i.needsInput=undefined;await this.save();this.resume(i.projectId,i.workerId);i.inspected=false;this.expanded=false;this.resize();}
  async removeProject(id:string){for(const [key,i] of this.instances)if(i.projectId===id){i.view.webContents.close();i.server?.close();this.instances.delete(key);}if(!this.instances.has(this.selected!))this.selected=this.instances.keys().next().value;this.layout();if(!this.instances.size){this.visible=false;this.layout();}await this.save();}
  show(){if(!this.instances.size)return {empty:true};this.open();this.visible=true;this.layout();return {empty:false};}
  async close(){await this.save();this.visible=false;this.attach(undefined);this.server.closeAllConnections();await new Promise<void>(r=>this.server.close(()=>r()));for(const i of this.instances.values()){i.view.webContents.close();i.server?.close();}this.instances.clear();this.chrome?.webContents.close();this.chrome=undefined;}
}
