import { checkForUpdate, type AvailableUpdate } from './updates.ts';
import { previewWebsite } from './preview.ts';
import { AgentBrowser } from './browser.ts';
import { app, Notification, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } from 'electron';
import { mediaType } from './engine/files-tool.ts';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { linkTarget } from './links.ts';
import { Onboarding } from './onboarding.ts';
import { PersonalAgentService } from './service.ts';

app.setName('PersonalAgent');
if (process.env.PERSONALAGENT_DATA_DIR) app.setPath('userData', process.env.PERSONALAGENT_DATA_DIR);
if (!app.requestSingleInstanceLock()) app.quit();
let window: BrowserWindow | null = null;
let service: PersonalAgentService;
let quitting = false;
let onboarding: Onboarding;
let browser: AgentBrowser;
const notified=new Set<string>();
let notificationsReady=false;
const source = app.getAppPath();
function nodePath() {
  const bundled = join(process.resourcesPath, 'runtime/node');
  if (existsSync(bundled)) return bundled;
  if (process.env.PERSONALAGENT_NODE) return process.env.PERSONALAGENT_NODE;
  for (const path of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) if (existsSync(path)) return path;
  throw new Error('Node.js 24 or newer is required.');
}
function openWindow() {
  window = new BrowserWindow({ width: 1160, height: 800, minWidth: 780, minHeight: 580, title: 'PersonalAgent',
    backgroundColor: '#faf8f2', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 20 },
    webPreferences: { preload: join(source, 'desktop-dist/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  void window.loadFile(join(source, 'desktop/ui/index.html'));
  browser?.attach(window);window.on('resize',()=>browser?.relayout());
  window.on('close',()=>browser?.attach(undefined));
  window.on('closed', () => { window = null; });
}
app.on('second-instance', () => { if (!window) openWindow(); window?.show(); window?.focus(); });
void app.whenReady().then(async () => {
// Finder launches lack a login-shell PATH; preserve ordinary shell command discovery.
try { process.env.PATH = execFileSync('/bin/zsh', ['-lc', 'printf "%s" "$PATH"'], { encoding: 'utf8', timeout: 4000 }); } catch {}
service = new PersonalAgentService(source, nodePath(), app.getPath('userData'), () => {const state=service.state();window?.webContents.send('state',state);
  for(const p of state.projects){const last=p.messages.at(-1);if(!last||notified.has(last.id))continue;
    if(p.status==='idle'&&!p.workers.some(w=>['working','disconnected','compacting'].includes(w.status))&&last.role==='assistant'||p.status==='blocked'||last.role==='error'){
      notified.add(last.id);if(notificationsReady&&!window?.isFocused()&&Notification.isSupported()){const n=new Notification({title:p.name,body:last.text.slice(0,180)||'Your result is ready.'});n.on('click',()=>{void service.select(p.id);if(!window)openWindow();window?.show();window?.focus();});n.show();}
    }
  }
});
browser=new AgentBrowser(app.getPath('userData'),source,id=>service.store.get(id),(id,text)=>{
  if(Notification.isSupported()) { const notice=new Notification({title:'PersonalAgent',body:text});notice.on('click',()=>{void service.select(id);window?.show();window?.focus();});notice.show(); }
},(id,workerId,restoring)=>void service.browserContinue(id,workerId,restoring).catch(console.error));
await browser.start();
await service.initialize();
await browser.restore();
for(const p of service.store.projects)for(const m of p.messages)notified.add(m.id);notificationsReady=true;
function handle(name: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== window?.webContents) throw new Error('Unknown window.');
    try { return { ok: true, value: await fn(...args) }; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Something went wrong.' }; }
  });
}
onboarding = new Onboarding(app.getPath('userData'), url => shell.openExternal(url), () => {
  if (!window) openWindow();
  if (window?.isMinimized()) window.restore();
  window?.show(); window?.focus(); app.focus({ steal: true });
  window?.webContents.send('onboarding-complete');
});
handle('bootstrap', async () => ({ ...service.state(), ...await service.catalog(), onboardingComplete: await onboarding.complete() }));
let latestUpdate: AvailableUpdate | null = null;
let lastUpdateCheck = 0;
let updateRequest: Promise<AvailableUpdate | null> | undefined;
handle('check-update', async () => {
  if (Date.now() - lastUpdateCheck < 60 * 60 * 1000) return latestUpdate;
  updateRequest ??= checkForUpdate(app.getVersion()).then(value => { latestUpdate = value; lastUpdateCheck = Date.now(); return value; }).finally(() => { updateRequest = undefined; });
  return updateRequest;
});
handle('open-update', async () => { if (latestUpdate) await shell.openExternal(latestUpdate.url); });
handle('show-browser', () => browser.show());
handle('login', () => onboarding.start());
handle('cancel-login', () => onboarding.cancel());
handle('finish-onboarding', () => onboarding.useExisting());
handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(window!, { title: 'Choose a project folder', properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Choose folder' });
  return result.canceled ? null : result.filePaths[0];
});
handle('add-project', (folder, coordinator, worker) => service.add(folder, coordinator, worker));
handle('select-project', id => service.select(id));
handle('manage-worker', (id, workerId, action, name) => service.manageWorker(id, workerId, action, name));
handle('remove-project', async id => {await service.remove(id);await browser.removeProject(id);});
handle('send', (id, message, attachments) => service.send(id, message, attachments));
handle('pick-files',async()=>{const result=await dialog.showOpenDialog(window!,{properties:['openFile','multiSelections']});return result.canceled?[]:result.filePaths;});
handle('attach-files',async(paths)=>Promise.all(paths.map(async(path:string)=>{const info=await stat(path);if(!info.isFile())throw new Error('Choose files');return {path,name:basename(path),size:info.size,mediaType:mediaType(path)};})));
handle('paste-image',async(id,base64)=>{if(typeof base64!=='string'||base64.length>20_000_000)throw new Error('Image too large');const folder=join(service.store.get(id).folder,'attachments');await mkdir(folder,{recursive:true});const path=join(folder,`image-${randomUUID()}.png`);await writeFile(path,Buffer.from(base64,'base64'));return {path,name:basename(path),mediaType:'image/png'};});
handle('file-preview',async(path)=>{const mime=mediaType(path);
  if(mime==='text/html'){await previewWebsite(path);return {mediaType:mime,opened:true};}
const info=await stat(path);if(info.size>20_000_000)return {mediaType:mime};const data=await readFile(path);return mime.startsWith('image/')||mime==='application/pdf'?{mediaType:mime,url:`data:${mime};base64,${data.toString('base64')}`}:{mediaType:mime,text:data.toString('utf8')};});
handle('open-file',path=>shell.openPath(path));
handle('cancel', id => service.cancel(id));
handle('open-link', async (id, value) => {
  const target = linkTarget(value, service.store.get(id).folder);
  if ('url' in target) await shell.openExternal(target.url);
  else { const { stat } = await import('node:fs/promises'); await stat(target.path); shell.showItemInFolder(target.path); }
});
handle('copy-text', text => { if (typeof text !== 'string' || text.length > 1_000_000) throw new Error('Text is too large to copy.'); clipboard.writeText(text); });
handle('reveal-project', id => shell.openPath(service.store.get(id).folder));
Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: 'PersonalAgent', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
  { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
]));
openWindow();
app.on('activate', () => { if (!window) openWindow(); });
app.on('before-quit', event => {
  if (quitting) return; event.preventDefault(); quitting = true; onboarding?.cancel();
  void Promise.allSettled([service.shutdown(),browser.close()]).finally(() => app.quit());
});
}).catch(error => {
  console.error(error);
  dialog.showErrorBox('PersonalAgent could not start', error instanceof Error ? error.message : String(error));
  app.quit();
});
