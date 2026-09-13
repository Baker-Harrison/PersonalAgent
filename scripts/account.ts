import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createPi, providerId } from '../agent/lib/pi.ts';
import { saveModel, selectedModel, saveReasoning, selectedReasoning } from '../agent/lib/settings.ts';
import { reasoningChoices } from '../agent/lib/reasoning.ts';

const models = createPi();
const command = process.argv[2];
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

try {
  if (command === 'login') {
    const readline = createInterface({ input: stdin, output: stdout });
    try {
      await models.login(providerId, 'oauth', {
        signal: controller.signal,
        async prompt(prompt) {
          if (prompt.type === 'select') console.log(prompt.options.map(o => `${o.id}: ${o.label}`).join('\n'));
          return readline.question(`${prompt.message}\n> `, { signal: prompt.signal ?? controller.signal });
        },
        notify(event) {
          if (event.type === 'auth_url') console.log(`\nSign in with ChatGPT:\n${event.url}\n`);
          else if (event.type === 'device_code') console.log(`Open ${event.verificationUri} and enter ${event.userCode}`);
          else console.log(event.message);
        },
      });
      console.log('ChatGPT sign-in saved for Eve Pi.');
    } finally { readline.close(); }
  } else if (command === 'logout') {
    await models.logout(providerId);
    console.log('Eve Pi credentials removed.');
  } else if (command === 'status') {
    const auth = await models.checkAuth(providerId);
    console.log(auth?.type === 'oauth' ? 'ChatGPT OAuth credentials saved. Refresh is checked when making a request.' : 'Not signed in. Run npm run login.');
    try { console.log(`Model: ${(await selectedModel()).id}`); } catch { console.log('Model: not selected'); }
    console.log(`Reasoning: ${await selectedReasoning()}`);
  } else if (command === 'models') {
    for (const model of models.getModels(providerId)) console.log(`${model.id}\t${model.contextWindow.toLocaleString()} context tokens`);
  } else if (command === 'model' && process.argv[3]) {
    await saveModel(process.argv[3]);
    console.log(`Selected ${process.argv[3]}. Restart Eve to apply.`);
  } else if (command === 'reasoning') {
    if (process.argv[3]) console.log(`Reasoning: ${await saveReasoning(process.argv.slice(3).join(' '))}. Restart Eve to apply.`);
    else {
      console.log(`Current: ${await selectedReasoning()}`);
      console.log(Object.keys(reasoningChoices).join(' | '));
      console.log('Change with: npm run reasoning -- "Extra High"');
    }
  } else throw new Error('Usage: account.ts login | logout | status | models | model <id>');
} catch (error) {
  // OAuth errors can contain response bodies. Keep account commands free of credentials.
  if (command === 'login') console.error('Sign-in did not finish. Retry npm run login.');
  else console.error(error instanceof Error ? error.message : 'Account command failed.');
  process.exitCode = 1;
}
