const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('browserUI',{call:(action,id)=>ipcRenderer.invoke('browser-ui',action,id),onState:callback=>ipcRenderer.on('browser-state',(_event,state)=>callback(state))});
