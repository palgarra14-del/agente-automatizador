import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const binary = process.env.CLOUDFLARED_BIN || join(homedir(), '.local', 'bin', 'cloudflared');
const target = process.env.AGENT_CONTROL_TARGET || 'http://127.0.0.1:8787';
const urlFile = process.env.AGENT_CONTROL_TUNNEL_URL_FILE || join(homedir(), '.config', 'agent-control-center', 'tunnel-url');
await mkdir(dirname(urlFile), {recursive:true, mode:0o700});

const child = spawn(binary, ['tunnel', '--url', target, '--no-autoupdate'], {stdio:['ignore','pipe','pipe']});
let saved = false;
const handle = async (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (saved) return;
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (!match) return;
  saved = true;
  await writeFile(urlFile, match[0] + '\n', {mode:0o600});
  console.log('AGENT_CONTROL_PUBLIC_URL=' + match[0]);
};
child.stdout.on('data', (chunk) => handle(chunk).catch(console.error));
child.stderr.on('data', (chunk) => handle(chunk).catch(console.error));
child.on('exit', (code, signal) => process.exitCode = code ?? (signal ? 1 : 0));
for (const signal of ['SIGINT','SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
