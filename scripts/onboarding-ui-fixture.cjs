const { contextBridge } = require('electron');
let complete, rejectLogin;
contextBridge.exposeInMainWorld('personalAgent', {
  bootstrap: async () => ({ projects: [], selectedId: null, models: [], defaults: {}, signedIn: false, onboardingComplete: false }),
  onState: () => {}, onOnboardingComplete: callback => complete = callback,
  login: () => new Promise((resolve, reject) => { rejectLogin = reject; }),
  cancelLogin: async () => rejectLogin(Error('Sign-in cancelled. Try again.')),
});
contextBridge.exposeInMainWorld('onboardingFixture', { finish: () => complete() });
