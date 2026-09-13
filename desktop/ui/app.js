import { isBusy, toolNames, blocks, workerStatus, workerAction, progressState } from './presentation.js';
const api = window.personalAgent;
const $ = id => document.getElementById(id);
const icons = {
  folder: '<svg viewBox="0 0 24 24"><path d="M3 6.5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M12 18V6m-5 5 5-5 5 5"/></svg>',
  browser: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/></svg>',
};
let attachments = [];
let state = { projects: [], selectedId: null }, catalog = [], defaults, editing = null, folder = null;
let toastTimer, draftProject = null, frame = 0, sidebarSignature = '', receivedAt = 0;
const attachmentDrafts=new Map();
const sending = new Set(), stopping = new Set(), drafts = new Map(), views = new Map();
const project = () => state.projects.find(p => p.id === state.selectedId);
const view = id => { if (!views.has(id)) views.set(id, { scroll: 0, following: true, unread: false, workerId: null }); return views.get(id); };
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 7000); }
async function attempt(fn) { try { return await fn(); } catch (e) { toast(e.message); } }
function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function putText(el, text) { if (el.textContent !== text) el.textContent = text; }
function inline(parent, text) {
  // Construct DOM explicitly. Model-generated HTML never becomes executable markup.
  const pattern = /(\[[^\]\n]+\]\([^\s]+?\)|https?:\/\/[^\s<>]+|\*\*[^*]+\*\*|`[^`]+`)/g;
  for (const part of text.split(pattern)) {
    const link = part.match(/^\[([^\]]+)\]\((.+)\)$/);
    if (link || /^https?:\/\//.test(part)) {
      const value = link ? link[2] : part.replace(/[.,;]+$/, '');
      const a = node('a', '', link ? link[1] : value); a.href = '#'; a.dataset.link = value;
      a.title = /^https?:/.test(value) ? value : `Show in Finder: ${value}`;
      parent.append(a); if (!link) parent.append(document.createTextNode(part.slice(value.length)));
    } else if (part.startsWith('**') && part.endsWith('**')) parent.append(node('strong', '', part.slice(2, -2)));
    else if (part.startsWith('`') && part.endsWith('`')) parent.append(node('code', '', part.slice(1, -1)));
    else parent.append(document.createTextNode(part));
  }
}
function renderBlock(block) {
  if (block.type === 'code') {
    const wrap = node('div', 'code-block'), header = node('div', 'code-heading'), copy = node('button', 'copy-code', 'Copy');
    copy.type = 'button'; copy.setAttribute('aria-label', 'Copy code');
    copy.onclick = () => void attempt(async () => { await api.copyText(block.text); copy.textContent = 'Copied'; setTimeout(() => { if (copy.isConnected) copy.textContent = 'Copy'; }, 1500); });
    header.append(node('span', '', block.language || 'Code'), copy);
    const pre = node('pre'); pre.append(node('code', '', block.text)); wrap.append(header, pre); return wrap;
  }
  const container = node('div', 'prose-block'); let list;
  for (const line of block.text.split('\n')) {
    const item = line.match(/^\s*(?:([-*+])|\d+[.)])\s+(.+)$/), heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (item) {
      const tag = item[1] ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== tag) { list = node(tag); if (tag === 'ol') list.start = parseInt(line, 10); container.append(list); }
      const li = node('li'); inline(li, item[2]); list.append(li);
    } else {
      list = null; const p = node(heading ? 'h3' : line.startsWith('> ') ? 'blockquote' : 'p');
      inline(p, heading ? heading[2] : line.replace(/^> /, '')); container.append(p);
    }
  }
  return container;
}
function selectedInside(el) {
  const selection = window.getSelection();
  return selection && !selection.isCollapsed && (el.contains(selection.anchorNode) || el.contains(selection.focusNode));
}
function formatted(parent, text) {
  const parts = blocks(text);
  parts.forEach((block, i) => {
    const signature = JSON.stringify(block), old = parent.children[i];
    if (old?.dataset.signature === signature || old && (selectedInside(old) || old.contains(document.activeElement))) return;
    const el = renderBlock(block); el.dataset.signature = signature;
    if (old) old.replaceWith(el); else parent.append(el);
  });
  while (parent.children.length > parts.length && !selectedInside(parent.lastChild)) parent.lastChild.remove();
}
function reconcile(parent, items, key, update) {
  const existing = new Map([...parent.children].map(el => [el.dataset.id, el]));
  let cursor = parent.firstElementChild;
  for (const item of items) {
    const id = key(item); let el = existing.get(id);
    if (!el) { el = update(null, item); el.dataset.id = id; }
    else update(el, item);
    if (el !== cursor) parent.insertBefore(el, cursor);
    cursor = el.nextElementSibling; existing.delete(id);
  }
  for (const el of existing.values()) el.remove();
}
function renderTool(el, a) {
  if (!el) { el = node('details', 'activity-tool'); el.append(node('summary'), node('pre', 'activity-input'), node('pre', 'activity-output')); }
  const status = { preparing: 'Preparing', running: 'Running', done: 'Done', failed: 'Failed', stopped: 'Stopped' }[a.status] || a.status;
  putText(el.firstChild, `${toolNames[a.name] || a.name} · ${status}`);
  // Large outputs are materialized only when their disclosure is open.
  el.ontoggle = () => { if (el.open) { putText(el.children[1], a.input || ''); putText(el.children[2], a.output || ''); } };
  if (el.open) { putText(el.children[1], a.input || ''); putText(el.children[2], a.output || ''); }
  el.dataset.status = a.status; return el;
}
function renderWorkers(p, v) {
  const workers = p?.workers || [];
  $('worker-dock').hidden = !workers.length;
  reconcile($('worker-list'), workers, w => w.id, (el, w) => {
    if (!el) { el = node('button', 'worker-chip'); el.append(node('span', 'worker-indicator'), node('span', 'worker-name')); }
    const name = w.displayName || 'Worker';
    putText(el.children[1], name);
    el.dataset.status = w.status;
    el.setAttribute('aria-label', `${name} · ${workerStatus(w)}`);
    el.setAttribute('aria-expanded', String(v.workerId === w.id));
    el.setAttribute('aria-controls', 'worker-menu'); el.setAttribute('aria-haspopup', 'menu');
    el.title = `${name}: ${workerAction(w)}`;
    el.onclick = () => { v.workerId = v.workerId === w.id ? null : w.id; renderWorkers(p, v); };
    return el;
  });
  const w = workers.find(w => w.id === v.workerId);
  $('worker-menu').hidden = !w;
  if(w) {
    const chip=[...$('worker-list').children].find(el=>el.dataset.id===w.id), rect=chip.getBoundingClientRect();
    $('worker-menu').style.top = `${rect.bottom+4}px`;
    $('worker-menu').style.right = `${innerWidth-rect.right}px`;
  }
  const progress = progressState(p);
  if (stopping.has(p?.id)) { progress.text = 'Stopping…'; progress.spinning = true; }
  if (sending.has(p?.id)) { progress.text = 'Sending…'; progress.spinning = true; }
  $('agent-progress').hidden = !progress.text;
  $('agent-progress').dataset.spinning = String(progress.spinning);
  putText($('agent-progress-text'), progress.text);
}
function render() {
  frame = 0; const start = performance.now(), p = project(), scroll = $('conversation');
  const switching = draftProject !== state.selectedId;
  if (switching) {
    if (draftProject) { attachmentDrafts.set(draftProject,attachments); drafts.set(draftProject, $('message').value); view(draftProject).scroll = scroll.scrollTop; }
    draftProject = state.selectedId; attachments=attachmentDrafts.get(draftProject)||[];renderAttachments(); $('message').value = drafts.get(draftProject) || ''; resize();
    $('messages').replaceChildren();
  }
  const v = view(state.selectedId);
  const nextSidebar = JSON.stringify(state.projects.map(p => [p.id, p.name, p.folder, isBusy(p), p.connection, p.status, p.id === state.selectedId]));
  if (nextSidebar !== sidebarSignature) {
    sidebarSignature = nextSidebar;
    reconcile($('projects'), state.projects, p => p.id, (button, item) => {
      if (!button) { button = node('button', 'project'); button.innerHTML = icons.folder; button.append(node('span', 'project-name'), node('span', 'project-state')); button.onclick = () => void attempt(() => api.selectProject(item.id)); }
      button.oncontextmenu = event => {event.preventDefault(); $('project-menu').dataset.projectId=item.id; $('project-menu').hidden=false; $('project-menu').style.top=`${event.clientY}px`; $('project-menu').style.left=`${event.clientX}px`;};
      button.title = item.folder; button.classList.toggle('selected', item.id === state.selectedId);
      button.setAttribute('aria-current', item.id === state.selectedId ? 'page' : 'false');
      putText(button.children[1], item.name);
      putText(button.children[2], item.connection === 'offline' ? 'Offline' : item.status === 'blocked' ? 'Needs input' : isBusy(item) ? 'Working' : '');
      return button;
    });
  }
  putText($('project-title'), p?.name || ''); $('composer-area').hidden = !p;
  const messages = (p?.messages || []).filter(m => ['user', 'assistant', 'error'].includes(m.role));
  $('welcome').hidden = messages.length > 0;
  putText($('welcome').querySelector('h1'), p ? 'New conversation' : 'Projects');
  putText($('welcome').querySelector('p'), p ? `Send a message to work on ${p.name}.` : 'Add a project folder to get started.');
  $('welcome-add').hidden = !!p;
  let changed = false;
  reconcile($('messages'), messages, m => m.id, (el, m) => {
    if (!el) { el = node('article', `message ${m.role}`); el.append(node('div', 'message-text')); changed = true; }
    if (el.dataset.text !== m.text || el.dataset.deferred) {
      if (m.role === 'assistant') formatted(el.firstChild, m.text);
      else if (!selectedInside(el.firstChild)) putText(el.firstChild, m.text);
      if (selectedInside(el.firstChild) || el.firstChild.contains(document.activeElement)) el.dataset.deferred = 'true'; else delete el.dataset.deferred;
      el.dataset.text = m.text; changed = true;
    }
    if(m.attachments?.length&&!el.querySelector('.result-previews,.file-cards')){
      const results=node('div',m.role==='assistant'?'result-previews':'file-cards');
      for(const file of m.attachments){
        const open=()=>void attempt(()=>preview(file));
        if(m.role!=='assistant'){const button=node('button','file-card',file.name);button.onclick=open;results.append(button);continue;}
        if(file.mediaType?.startsWith('image/'))void api.filePreview(file.path).then(data=>{
          if(data.url){const img=node('img','inline-image');img.alt='Result preview';img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label','Open image preview');img.onclick=open;img.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}};
            img.onload=()=>{if(state.selectedId===p.id&&view(p.id).following)$('conversation').scrollTop=$('conversation').scrollHeight;};img.src=data.url;results.prepend(img);}
        }).catch(error=>{if(results.isConnected)toast(error.message);});
        else if(file.mediaType==='text/html'){const button=node('button','preview-link','Open preview');button.onclick=open;results.append(button);}
      }
      el.append(results);
    }
    if (m.role === 'user') {
      const label = { sending: 'Sending…', accepted: 'Received', uncertain: 'Delivery unconfirmed', failed: 'Not sent' }[m.delivery] || '';
      let status = el.querySelector('.delivery-status');
      if (label && !status) { status = node('small', 'delivery-status'); el.append(status); }
      if (status) { putText(status, label); status.hidden = !label; }
    }
    return el;
  });
  const previousProgress = $('agent-progress-text').textContent;
  renderWorkers(p, v);
  changed ||= previousProgress !== $('agent-progress-text').textContent;
  if (switching) scroll.scrollTop = v.following ? scroll.scrollHeight : v.scroll;
  else if (changed && v.following && !selectedInside($('messages'))) scroll.scrollTop = scroll.scrollHeight;
  else if (changed) v.unread = true;
  $('new-messages').hidden = !v.unread;
  $('message').disabled = p?.status === 'compacting';
  $('send').disabled = !p || p.status === 'compacting' || sending.has(p.id) || (!$('message').value.trim() && !attachments.length);
  performance.measure('conversation-render', { start, end: performance.now() });
  if (receivedAt) { performance.measure('state-to-render', { start: receivedAt, end: performance.now() }); receivedAt = 0; }
  // Keep diagnostic timing bounded. No conversation content is recorded.
  for (const name of ['conversation-render', 'state-to-render']) if (performance.getEntriesByName(name).length > 200) performance.clearMeasures(name);
}
function scheduleRender() { if (!frame) frame = requestAnimationFrame(render); }
$('conversation').addEventListener('scroll', () => {
  const el = $('conversation'), v = view(state.selectedId); v.scroll = el.scrollTop;
  v.following = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  if (v.following) { v.unread = false; $('new-messages').hidden = true; }
}, { passive: true });
$('new-messages').onclick = () => { const v = view(state.selectedId); v.following = true; v.unread = false; $('conversation').scrollTop = $('conversation').scrollHeight; $('new-messages').hidden = true; };
function closeWorker() {
  const v = view(state.selectedId), id = v.workerId; v.workerId = null; renderWorkers(project(), v);
  [...$('worker-list').children].find(el => el.dataset.id === id)?.focus();
}
$('worker-rename').onclick = () => { const w=project()?.workers.find(w=>w.id===view(state.selectedId).workerId);if(!w)return; $('rename-input').value=w.displayName||''; $('rename-dialog').showModal(); $('rename-input').select(); };
$('rename-form').onsubmit = event => {event.preventDefault();void attempt(async()=>{await api.manageWorker(state.selectedId,view(state.selectedId).workerId,'rename',$('rename-input').value);$('rename-dialog').close();closeWorker();});};
$('rename-cancel').onclick=()=>$('rename-dialog').close();
$('worker-delete').onclick=()=>void attempt(async()=>{const id=view(state.selectedId).workerId;closeWorker();await api.manageWorker(state.selectedId,id,'delete');});
$('project-remove').onclick=()=>void attempt(async()=>{const id=$('project-menu').dataset.projectId;$('project-menu').hidden=true;await api.removeProject(id);});
document.addEventListener('click',event=>{if(!event.target.closest('.worker-chip,#worker-menu,#rename-dialog'))closeWorker();if(!event.target.closest('#project-menu'))$('project-menu').hidden=true;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeWorker();$('project-menu').hidden=true;}});
document.addEventListener('focusout', scheduleRender);
document.addEventListener('selectionchange', () => { if (window.getSelection()?.isCollapsed) scheduleRender(); });
document.addEventListener('click', event => { const a = event.target.closest('a[data-link]'); if (a) { event.preventDefault(); void attempt(() => api.openLink(state.selectedId, a.dataset.link)); } });
function resize() { $('message').style.height = 'auto'; $('message').style.height = Math.min($('message').scrollHeight, 180) + 'px'; }
function populateRole(role, selection) {
  const models = $(role + '-model'); models.replaceChildren();
  for (const m of catalog) models.append(new Option(m.name || m.id, m.id));
  models.value = selection.model;
  populateReasoning(role, selection.reasoning);
}
function populateReasoning(role, selected) {
  const model = catalog.find(m => m.id === $(role + '-model').value);
  const el = $(role + '-reasoning'); const previous = selected || el.value; el.replaceChildren();
  for (const label of model?.reasoning || []) el.append(new Option(label, label));
  if (model?.reasoning.includes(previous)) el.value = previous;
}
function openSettings(path) {
  folder=path;
  $('dialog-title').textContent='New project';
  $('folder-name').textContent=folder.split('/').filter(Boolean).at(-1)||folder;
  $('folder-name').title=folder;
  populateRole('coordinator',defaults);populateRole('worker',defaults);
  $('settings-note').textContent='';$('save-project').disabled=false;$('save-project').textContent='Create project';
  $('project-dialog').showModal();
}
async function add() { const path = await api.pickFolder(); if (path) openSettings(path); }
$('add-project').onclick = $('welcome-add').onclick = () => attempt(add);
$('folder-icon').innerHTML = icons.folder;
$('send').innerHTML = icons.send;
$('show-browser').innerHTML = icons.browser;
$('close-dialog').onclick = $('cancel-dialog').onclick = () => $('project-dialog').close();
for (const role of ['coordinator', 'worker']) $(role + '-model').onchange = () => populateReasoning(role);
$('project-form').onsubmit = event => {
  event.preventDefault(); const selection = role => ({ model: $(role + '-model').value, reasoning: $(role + '-reasoning').value });
  void attempt(async () => { $('save-project').disabled = true; try { await api.addProject(folder, selection('coordinator'), selection('worker')); $('project-dialog').close(); $('message').focus(); } finally { $('save-project').disabled = false; } });
};
$('message').oninput = () => { resize(); $('send').disabled = project()?.status === 'compacting' || sending.has(state.selectedId) || (!$('message').value.trim()&&!attachments.length); };
$('message').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); } };
$('composer').onsubmit = event => {
  event.preventDefault(); const p = project(), text = $('message').value.trim(); if (!p || (!text&&!attachments.length) || p.status==='compacting' || sending.has(p.id)) return;
  const files=attachments;attachments=[];attachmentDrafts.delete(p.id);renderAttachments();
  sending.add(p.id); view(p.id).following = true; view(p.id).unread = false; $('message').value = ''; drafts.delete(p.id); resize(); render();
  void attempt(async () => { try { await api.send(p.id, text, files); } finally { sending.delete(p.id); scheduleRender(); } });
};
api.onState(next => { state = next; receivedAt ||= performance.now(); scheduleRender(); });
let onboardingStep = 0, signedIn = false, loggingIn = false;
const onboardingPages = [
  ['Meet PersonalAgent', 'Talk through an idea. Give your agents a task. Keep the conversation going while they work.'],
  ['Your work, on your Mac', 'Choose a project folder and your agents work with its files. Follow their progress, ask questions, or change direction in the conversation. Keep your Mac awake while they work.'],
  ['Connect ChatGPT', 'Sign in securely in your browser. When you finish, you will return here and PersonalAgent will open.'],
];
function showOnboarding(show) {
  $('onboarding').hidden = !show;
  document.querySelector('.sidebar').inert = show;
  document.querySelector('main').inert = show;
  if (show) renderOnboarding();
}
function renderOnboarding() {
  $('onboarding-step').textContent = `${onboardingStep + 1} of 3`;
  $('onboarding-title').textContent = onboardingPages[onboardingStep][0];
  $('onboarding-description').textContent = onboardingPages[onboardingStep][1];
  $('onboarding-back').hidden = onboardingStep === 0;
  $('onboarding-back').disabled = loggingIn;
  $('onboarding-next').disabled = loggingIn;
  $('onboarding-next').textContent = loggingIn ? 'Waiting for ChatGPT…' : onboardingStep === 2 ? signedIn ? 'Open PersonalAgent' : 'Sign in with ChatGPT' : 'Next';
  $('onboarding-status').textContent = loggingIn ? 'Finish signing in in your browser. This window will open when you are done.' : onboardingStep === 2 && signedIn ? 'Your ChatGPT account is already connected.' : '';
  $('onboarding-cancel').hidden = !loggingIn;
}
async function enterApp() {
  signedIn = true; loggingIn = false; showOnboarding(false);
  $('connection').textContent = ''; $('connection').title = 'ChatGPT connected';
  render();
  if (state.selectedId) await api.selectProject(state.selectedId);
  (state.selectedId ? $('message') : $('welcome-add')).focus();
}
api.onOnboardingComplete?.(() => void attempt(enterApp));
$('onboarding-back').onclick = () => { onboardingStep--; renderOnboarding(); $('onboarding-title').focus(); };
$('onboarding-next').onclick = async () => {
  if (onboardingStep < 2) { onboardingStep++; renderOnboarding(); $('onboarding-title').focus(); return; }
  loggingIn = true; renderOnboarding();
  try { if (signedIn) await api.finishOnboarding(); else await api.login(); }
  catch (e) { loggingIn = false; renderOnboarding(); $('onboarding-status').textContent = e.message; }
};
$('onboarding-cancel').onclick = () => void attempt(() => api.cancelLogin());
void attempt(async () => {
  const data = await api.bootstrap(); catalog = data.models; defaults = data.defaults; state = data; signedIn = data.signedIn;
  $('connection').textContent = signedIn ? '' : 'Not connected';
  $('connection').title = signedIn ? 'ChatGPT connected' : 'Sign in with ChatGPT';
  render();
  const needsOnboarding = data.onboardingComplete === false || !signedIn;
  if (data.onboardingComplete && !signedIn) onboardingStep = 2;
  showOnboarding(needsOnboarding);
  if (!needsOnboarding && data.selectedId) await api.selectProject(data.selectedId);
});

const attachmentPreviews=new Map();
function renderAttachments(){
  $('attachments').replaceChildren(...attachments.map((file,index)=>{
    const remove=()=>{attachments.splice(index,1);renderAttachments();render();};
    if(!file.mediaType?.startsWith('image/')){const b=node('button','file-card',file.name+' ×');b.type='button';b.onclick=remove;return b;}
    const tile=node('div','attachment-thumbnail'),img=node('img');img.alt=file.name;
    const button=node('button','attachment-remove','×');button.type='button';button.setAttribute('aria-label','Remove '+file.name);button.title='Remove image';button.onclick=remove;
    tile.append(img,button);
    if(!attachmentPreviews.has(file.path))attachmentPreviews.set(file.path,api.filePreview(file.path).catch(()=>null));
    void attachmentPreviews.get(file.path).then(data=>{if(data?.url)img.src=data.url;else {img.hidden=true;tile.prepend(node('span','attachment-fallback',file.name));}});
    return tile;
  }));
  for(const path of attachmentPreviews.keys())if(!attachments.some(f=>f.path===path))attachmentPreviews.delete(path);
}
function addAttachments(id,files){
  if(!state.projects.some(p=>p.id===id))return;
  if(state.selectedId===id){attachments.push(...files);renderAttachments();render();}
  else attachmentDrafts.set(id,[...(attachmentDrafts.get(id)||[]),...files]);
}
async function attach(paths,id=state.selectedId){if(!id||!paths.length)return;addAttachments(id,await api.attachFiles(paths));}
$('attach').onclick=()=>{const id=state.selectedId;void attempt(async()=>attach(await api.pickFiles(),id));};
$('message').addEventListener('paste',event=>{const id=state.selectedId;const images=[...event.clipboardData.items].filter(item=>item.type.startsWith('image/'));if(!id||!images.length)return;event.preventDefault();for(const item of images){const reader=new FileReader();reader.onload=()=>void attempt(async()=>addAttachments(id,[await api.pasteImage(id,String(reader.result).split(',')[1])]));reader.readAsDataURL(item.getAsFile());}});
document.addEventListener('dragover',event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();});
document.addEventListener('drop',event=>{event.preventDefault();if(!state.selectedId)return;const paths=[...event.dataTransfer.files].map(file=>api.filePath(file)).filter(Boolean);void attempt(()=>attach(paths));});
async function preview(file){const data=await api.filePreview(file.path);if(data.opened)return;$('file-title').textContent=file.name;$('file-content').replaceChildren();if(data.url){const el=node(data.mediaType.startsWith('image/')?'img':'iframe');el.src=data.url;el.title=file.name;$('file-content').append(el);}else $('file-content').append(node('pre','',data.text||'Open this file locally to view it.'));$('file-open').onclick=()=>api.openFile(file.path);$('file-dialog').showModal();}
$('file-close').onclick=()=>$('file-dialog').close();
$('show-browser').onclick=()=>void attempt(async()=>{if((await api.showBrowser())?.empty)toast('No browser activity yet. Ask an agent to open a page.');});

async function refreshUpdate() {
  if (!api.checkUpdate) return;
  try {
    const update = await api.checkUpdate();
    $('update-app').hidden = !update;
    if (update) { $('update-app').textContent = `Update to ${update.version}`; $('update-app').title = 'Download the latest release from GitHub'; }
  } catch { /* Offline checks should not interrupt chat. Retry on the next interval. */ }
}
$('update-app').onclick = () => void attempt(() => api.openUpdate());
void refreshUpdate();
setInterval(() => void refreshUpdate(), 60 * 60 * 1000);
window.addEventListener('focus', () => void refreshUpdate());
