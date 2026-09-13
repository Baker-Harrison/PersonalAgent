// Isolated renderer regression test. No account, model, filesystem task or user app state.
const { app, BrowserWindow } = require('electron');
const { resolve, join } = require('node:path');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1160, height: 800, webPreferences: { preload: join(__dirname, 'desktop-ui-fixture.cjs'), contextIsolation: true, backgroundThrottling: false } });
  try {
    await window.loadFile(resolve(process.argv[2] || '.', 'desktop/ui/index.html'));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const wait = async ms => { await new Promise(r => setTimeout(r, ms)); await new Promise(requestAnimationFrame); };
      const check = (condition, message) => { if (!condition) throw Error(message); };
      await wait(100);
      const $ = id => document.getElementById(id);
      check($('update-app').hidden, 'Update button shown without an update');
      rendererFixture.setUpdate({version:'0.2.0'}); window.dispatchEvent(new Event('focus')); await wait(30);
      check(!$('update-app').hidden && $('update-app').textContent.includes('0.2.0'), 'Available update not shown');
      check($('update-app').closest('.sidebar-bottom'), 'Update button outside sidebar bottom');
      $('update-app').click(); await wait(10); check(rendererFixture.updateOpened(), 'Update click not forwarded');
      rendererFixture.setUpdate(null); window.dispatchEvent(new Event('focus')); await wait(30); check($('update-app').hidden, 'Stale update remains visible');
      let state = rendererFixture.state(), p = state.projects[0];
      const firstMessage = $('messages').firstChild, sidebar = $('projects').firstChild;
      const scroll = $('conversation'); scroll.scrollTop = 300; scroll.dispatchEvent(new Event('scroll'));
      const before = scroll.scrollTop;
      const input = $('message'); input.focus(); input.value = 'A draft worth keeping';
      const inputStart = performance.now(); input.dispatchEvent(new Event('input')); const inputMs = performance.now() - inputStart;
      const inputPaintStart = performance.now(); await new Promise(requestAnimationFrame); const inputFeedbackMs = performance.now() - inputPaintStart + inputMs;
      let sidebarMutations = 0;
      const observer = new MutationObserver(list => sidebarMutations += list.length); observer.observe($('projects'), { subtree: true, childList: true, characterData: true });
      for (let i = 0; i < 60; i++) { p.messages.at(-1).text += ' delta'; rendererFixture.emit(state); await wait(20); }
      check($('projects').firstChild === sidebar && sidebarMutations === 0, 'Sidebar mutated during text streaming'); observer.disconnect();
      check($('messages').firstChild === firstMessage, 'Existing message was replaced');
      check(Math.abs(scroll.scrollTop - before) < 2, 'Reading position moved during streaming');
      check(document.activeElement === input && input.value === 'A draft worth keeping', 'Draft or focus changed');
      check(!$('new-messages').hidden, 'New messages control missing');
      $('new-messages').click(); check(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 2, 'Jump to latest failed');
      const textNode = firstMessage.querySelector('.message-text').firstChild;
      const range = document.createRange(); range.selectNodeContents(textNode); getSelection().removeAllRanges(); getSelection().addRange(range);
      const selected = getSelection().toString(); p.messages.at(-1).text += ' another'; rendererFixture.emit(state); await wait(35);
      check(getSelection().toString() === selected, 'Text selection was lost'); getSelection().removeAllRanges();
      check($('conversation').contains($('agent-progress')), 'Spinner is outside chat');
      check($('agent-progress').dataset.spinning === 'true', 'Working spinner missing');
      const chatTop = $('conversation').getBoundingClientRect().top;
      const chatWidth = $('messages').getBoundingClientRect().width, composerWidth = $('composer').getBoundingClientRect().width;
      p.workers = [
        { id: 'one', displayName: 'Maya', status: 'working', task: 'Review the navigation', startedAt: 1, activity: [{ id: 'tool:w', name: 'bash', status: 'running', at: 3, input: JSON.stringify({ command: 'cat README.md' }), output: '' }], updates: [{ id: 'text:a', text: 'Checking navigation now.', at: 2, kind: 'progress' }] },
        { id: 'two', displayName: 'Finn', status: 'done', task: 'Check tests', updates: [], output: 'All checks passed.' },
        { id: 'three', displayName: 'Cleo', status: 'stopped', task: 'Review styling', updates: [], output: 'Stopped.' },
      ]; rendererFixture.emit(state); await wait(40);
      const chips = [...$('worker-list').children];
      check($('conversation').getBoundingClientRect().top === chatTop, 'Worker list pushed conversation down');
      check(chips[1].getBoundingClientRect().top > chips[0].getBoundingClientRect().bottom, 'Workers are not vertically spaced');
      check($('messages').getBoundingClientRect().width === chatWidth && $('composer').getBoundingClientRect().width === composerWidth, 'Floating workers changed chat or composer width');
      check(chips.length === 3 && chips.map(el => el.textContent).join(',') === 'Maya,Finn,Cleo', 'Names or status-only indicators incorrect');
      const colors = chips.map(el => getComputedStyle(el.firstChild).filter);
      check(new Set(colors).size === 3, 'Working, completed and stopped colors must differ');
      const activityStart = performance.now(); chips[0].click(); const activityMs = performance.now() - activityStart;
      check(!$('worker-menu').hidden, 'Worker menu did not open');
      check($('worker-menu').textContent === 'RenameDelete', 'Worker menu has unexpected controls');
      check(getComputedStyle($('worker-dock')).backgroundColor === 'rgba(0, 0, 0, 0)', 'White panel remains behind agents');
      check(!$('stop') && !$('model-shortcut'), 'Removed controls remain');
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));check($('worker-menu').hidden,'Escape did not close worker menu');
      p.status='compacting';rendererFixture.emit(state);await wait(80);check(input.disabled && input.value==='A draft worth keeping','Compaction lost draft or failed to disable input');
      p.status='thinking';rendererFixture.emit(state);await wait(80);check(!input.disabled,'Composer stayed disabled');
      p.workers[0].status = 'done'; p.status = 'idle'; p.activity[0].status = 'done'; rendererFixture.emit(state); for (let i = 0; i < 20 && !$('agent-progress').hidden; i++) await wait(20); check($('agent-progress').hidden, 'Idle spinner remains visible');
      p.status = 'blocked'; rendererFixture.emit(state); await wait(30); check($('agent-progress-text').textContent.includes('attention') && $('agent-progress').dataset.spinning === 'false', 'Blocked state is hidden or spinning');
      p.status = 'idle'; p.connection = 'offline'; rendererFixture.emit(state); await wait(30); check($('agent-progress-text').textContent.includes('Disconnected'), 'Offline state is hidden');
      state.selectedId = 'second'; rendererFixture.emit(state); await wait(40); input.value = 'Second draft'; input.dispatchEvent(new Event('input'));
      state.selectedId = 'qa'; rendererFixture.emit(state); await wait(40); check(input.value === 'A draft worth keeping', 'Project draft not restored');
      $('attach').click(); await wait(20);
      state.selectedId='second';rendererFixture.emit(state);await wait(40);
      rendererFixture.finishAttachments();await wait(40);
      check(!$('attachments').textContent.includes('qa-attachment.txt'),'Attachment leaked to a different project');
      state.selectedId='qa';rendererFixture.emit(state);await wait(40);
      check($('attachments').textContent.includes('qa-attachment.txt'),'Attachment was lost from its original project');
      $('attachments').firstChild.click();check(!$('attachments').children.length,'Attachment removal failed');
      $('show-browser').click();await wait(20);check($('toast').textContent.includes('No browser activity'),'Empty browser has no explanation');
      p.messages.push({ id: 'format', role: 'assistant', text: 'A [web link](https://example.com).\\n\\n1. First\\n2. Second\\n\\n' + String.fromCharCode(96).repeat(3) + 'js\\nconsole.log(1)\\n' + String.fromCharCode(96).repeat(3), at: 800 }); rendererFixture.emit(state); await wait(40);
      check($('messages').querySelector('a[data-link]') && $('messages').querySelector('ol') && $('messages').querySelector('.copy-code'), 'Rich response controls missing');
      $('messages').querySelector('.copy-code').click(); $('messages').querySelector('a[data-link]').click(); await wait(10);
      check(rendererFixture.copied() === 'console.log(1)', 'Copy did not preserve code');
      check(rendererFixture.opened() === 'https://example.com', 'Link target was not forwarded');
      check(!$('messages').querySelector('.activity-tool, .activity-task, .worker-card'), 'Routine activity leaked into conversation');
      p.messages.push({id:'preview',role:'assistant',text:'',at:900,attachments:[{path:'/tmp/index.html',name:'index.html',mediaType:'text/html'},{path:'/tmp/styles.css',name:'styles.css',mediaType:'text/css'},{path:'/tmp/proof.png',name:'proof.png',mediaType:'image/png'}]});rendererFixture.emit(state);await wait(60);
      const result=$('messages').lastChild;
      check(!result.querySelector('.file-card')&&!result.textContent.includes('styles.css')&&!result.textContent.includes('proof.png'),'Generated-file tiles leaked into the result');
      check(result.querySelector('.inline-image')&&result.querySelector('.preview-link'),'Rendered results are missing');
      const latencies = performance.getEntriesByName('state-to-render').map(e => e.duration).sort((a,b)=>a-b);
      const p95 = latencies[Math.floor(latencies.length * .95)], max = Math.max(...latencies);
      // Steady-state p95 and input stay below 100ms; a full 600-message project restore may take up to 500ms.
      check(inputFeedbackMs < 100 && activityMs < 100 && p95 < 100 && max < 500, 'Responsiveness budget exceeded: ' + JSON.stringify({ inputFeedbackMs, activityMs, max }));
      return { messages: 600, streamedUpdates: 60, inputFeedbackMs, activityMs, stateToRenderP95Ms: p95, stateToRenderMaxMs: max, sidebarMutations, checks: 'scroll, selection, focus, drafts, completion, attention, markdown' };
    })()`);
    console.log(JSON.stringify(result, null, 2)); app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
