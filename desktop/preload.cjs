const { contextBridge, ipcRenderer, webUtils } = require('electron');
const call = async (name, ...args) => {
  const result = await ipcRenderer.invoke(name, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld('personalAgent', {
  login: () => call('login'),
  cancelLogin: () => call('cancel-login'),
  finishOnboarding: () => call('finish-onboarding'),
  onOnboardingComplete: callback => { ipcRenderer.on('onboarding-complete', () => callback()); },
  checkUpdate: () => call('check-update'),
  openUpdate: () => call('open-update'),
  bootstrap: () => call('bootstrap'),
  pickFolder: () => call('pick-folder'),
  addProject: (folder, coordinator, worker) => call('add-project', folder, coordinator, worker),
  selectProject: id => call('select-project', id),
  manageWorker: (id, workerId, action, name) => call('manage-worker', id, workerId, action, name),
  removeProject: id => call('remove-project', id),
  send: (id, text, attachments) => call('send', id, text, attachments),
  pickFiles: () => call('pick-files'),
  attachFiles: paths => call('attach-files', paths),
  filePath: file => webUtils.getPathForFile(file),
  pasteImage: (id,base64) => call('paste-image',id,base64),
  filePreview: path => call('file-preview',path),
  openFile: path => call('open-file',path),
  showBrowser: () => call('show-browser'),
  cancel: id => call('cancel', id),
  openLink: (id, value) => call('open-link', id, value),
  copyText: text => call('copy-text', text),
  revealProject: id => call('reveal-project', id),
  onState: callback => { const handler = (_event, state) => callback(state); ipcRenderer.on('state', handler); return () => ipcRenderer.removeListener('state', handler); },
});
