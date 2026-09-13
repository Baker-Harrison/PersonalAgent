import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { AgentBrowser } from '../desktop/browser.ts';

void app.whenReady().then(async()=>{
  const root=await mkdtemp(join(tmpdir(),'personalagent-pip-'));
  const host=new BrowserWindow({width:1160,height:800,title:'PersonalAgent PiP check',backgroundColor:'#faf8f2',titleBarStyle:'hiddenInset',webPreferences:{preload:resolve('scripts/desktop-ui-fixture.cjs'),contextIsolation:true}});
  const browser=new AgentBrowser(root,resolve('.'),()=>({folder:root}),()=>{},()=>{});
  try {
    await host.loadFile(resolve('desktop/ui/index.html'));
    await host.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,150))`);
    await host.webContents.executeJavaScript(`(()=>{const s=rendererFixture.state(),p=s.projects[0];p.name='Cedar Tasks';p.messages=[{id:'1',role:'user',text:'Build a task board and verify it in the browser.',at:1},{id:'2',role:'assistant',text:'The app is built. I’m checking task creation and reload persistence now.',at:2}];p.workers=[{id:'a',displayName:'Emery',status:'working',task:'Checking browser interactions',output:'',cursor:0},{id:'b',displayName:'Milo',status:'done',task:'Build task storage',output:'',cursor:0}];p.activity=[];rendererFixture.emit(s);})()`);
    await writeFile(join(root,'index.html'),'<html><body style="background:#f7f3e8;color:#245c43;font:15px system-ui;padding:18px"><h2>Cedar Tasks</h2><p>Today</p><label><input type="checkbox"> Verify task persistence</label><hr style="border:0;border-top:1px solid #ddd"><label><input type="checkbox" checked> Build the shared task store</label></body></html>');
    await browser.start();browser.attach(host);
    await browser.command({projectId:'qa',workerId:'a',action:'open',url:'index.html',label:'Checking Cedar Tasks'});
    assert.equal(BrowserWindow.getAllWindows().length,1,'Browser must stay within the one application window');
    const internal=browser as any;
    internal.bounds.x=10000;internal.bounds.y=10000;browser.relayout();
    const [width,height]=host.getContentSize();assert.ok(internal.bounds.x+internal.bounds.width<=width);assert.ok(internal.bounds.y+internal.bounds.height<=height);
    const path=join(root,'pip.png');await writeFile(path,(await host.webContents.capturePage()).toPNG());console.log(JSON.stringify({path,root}));
    if(process.env.PA_KEEP_PIP){console.log('Ready for live PiP interaction');return;}
  } finally {if(!process.env.PA_KEEP_PIP){await browser.close();ipcMain.removeHandler('browser-ui');host.destroy();app.quit();}}
}).catch(error=>{console.error(error);app.exit(1);});
