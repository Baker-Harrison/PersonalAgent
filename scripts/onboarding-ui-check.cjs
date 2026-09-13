const { app, BrowserWindow } = require('electron');
const { resolve, join } = require('node:path');
const { writeFileSync } = require('node:fs');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1160, height: 800, webPreferences: { preload: join(__dirname, 'onboarding-ui-fixture.cjs'), contextIsolation: true, backgroundThrottling: false } });
  try {
    await window.loadFile(resolve('desktop/ui/index.html'));
    await new Promise(r => setTimeout(r, 200));
    writeFileSync('/tmp/personalagent-onboarding.png', (await window.webContents.capturePage()).toPNG());
    console.log(await window.webContents.executeJavaScript(`(async () => {
      const $ = id => document.getElementById(id), wait = () => new Promise(r => setTimeout(r, 50));
      const check = (ok, message) => { if (!ok) throw Error(message); };
      check(!$('onboarding').hidden && document.querySelector('main').inert, 'Onboarding must guard chat');
      check(document.querySelector('.onboarding-art').naturalWidth > 0, 'Artwork failed to load');
      $('onboarding-next').click(); check($('onboarding-title').textContent.includes('Mac'), 'Local work explanation missing');
      $('onboarding-back').click(); check($('onboarding-step').textContent === '1 of 3', 'Back failed');
      $('onboarding-next').click(); $('onboarding-next').click();
      check($('onboarding-next').textContent === 'Sign in with ChatGPT', 'Sign-in must be final');
      $('onboarding-next').click(); await wait(); check($('onboarding-next').disabled, 'Duplicate login allowed');
      $('onboarding-cancel').click(); await wait(); check(!$('onboarding-next').disabled && $('onboarding-status').textContent.includes('cancelled'), 'Cancel not recoverable');
      $('onboarding-next').click(); await wait(); onboardingFixture.finish(); await wait();
      check($('onboarding').hidden && !document.querySelector('main').inert, 'Successful login did not open app');
      return 'Onboarding navigation, artwork, cancellation, retry, and completion passed';
    })()`));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { window.destroy(); app.quit(); }
});
