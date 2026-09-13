import { spawn } from 'node:child_process';
import electron from 'electron';
const env = { ...process.env, PERSONALAGENT_NODE: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', code => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
