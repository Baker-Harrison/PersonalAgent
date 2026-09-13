const { contextBridge } = require('electron');
const choice = { model: 'gpt-5.6-luna', reasoning: 'Light' };
const project = { id: 'qa', name: 'Renderer check', folder: '/tmp', coordinator: choice, worker: choice, status: 'thinking', connection: 'connected', workers: [], activity: [{ id: 'tool:a', name: 'project_notes', status: 'running', at: 1, input: '{}', output: '' }], messages: Array.from({ length: 600 }, (_, i) => ({ id: String(i), role: i % 2 ? 'assistant' : 'user', text: `Message ${i}. A paragraph with enough content to test a long conversation.`, at: i })) };
project.messages.push({ id: 'stream', role: 'assistant', text: 'Streaming text', at: 700 });
let copied = '', opened = '';
let update = null, updateOpened = false;
let resolveAttachments;
let state = { projects: [project, { ...project, id: 'second', name: 'Second project', messages: [], activity: [], status: 'idle' }], selectedId: 'qa' }, listener;
contextBridge.exposeInMainWorld('personalAgent', {
  checkUpdate: async () => update,
  openUpdate: async () => { updateOpened = true; },
  bootstrap: async () => ({ ...state, models: [{ ...choice, id: choice.model, reasoning: ['Light'] }], defaults: choice, signedIn: true }),
  onState: callback => { listener = callback; }, selectProject: async id => { state.selectedId = id; listener(state); },
  send: async () => {}, cancel: async () => {}, openLink: async (_id, value) => { opened = value; }, copyText: async text => { copied = text; },
  pickFiles: async () => ['/tmp/qa-attachment.txt'],
  attachFiles: () => new Promise(resolve => { resolveAttachments = resolve; }),
  showBrowser: async () => ({empty:true}),
  filePreview: async () => ({mediaType:'image/png',url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII='}),
});
contextBridge.exposeInMainWorld('rendererFixture', { setUpdate: value => { update = value; }, updateOpened: () => updateOpened, state: () => state, copied: () => copied, opened: () => opened, finishAttachments: () => resolveAttachments([{path:'/tmp/qa-attachment.txt',name:'qa-attachment.txt'}]), emit: next => { state = next; listener(state); } });
