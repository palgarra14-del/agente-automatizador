import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, 'public');
const agentRoot = resolve(process.env.AGENT_ROOT || join(here, '..', '..', 'agente-automatizador'));
const host = process.env.AGENT_CONTROL_HOST || '127.0.0.1';
const port = Number(process.env.AGENT_CONTROL_PORT || 8787);
const repo = process.env.AGENT_CONTROL_REPO || 'palgarra14-del/agente-automatizador';
const tokenFile = process.env.AGENT_CONTROL_TOKEN_FILE || join(homedir(), '.config', 'agent-control-center', 'access-token');
const marker = '<!-- agent-request:v1 -->';

const laneScopes = Object.freeze({
  self: ['src', 'scripts', 'config', 'test', '.github', 'README.md', 'package.json'],
  leadfinder: ['src', 'public', 'docs', '.github', 'README.md', 'package.json'],
  callflow: ['api', 'tests', 'scripts', '.github', 'app.js', 'prospect.js', 'prospect-utils.js', 'callflow-navigation.js', 'styles.css', 'index.html'],
  'website-pilot': ['assets', 'test', 'scripts', 'docs', '.github', 'index.html', 'servicios', 'galeria', 'barberia', 'README.md']
});

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml'
};

async function ensureToken() {
  try {
    const value = (await readFile(tokenFile, 'utf8')).trim();
    if (value.length >= 12) return value;
  } catch {}
  await mkdir(dirname(tokenFile), { recursive: true, mode: 0o700 });
  const value = randomBytes(12).toString('base64url');
  await writeFile(tokenFile, value + '\n', { mode: 0o600 });
  return value;
}

const accessToken = await ensureToken();
const sessionValue = createHmac('sha256', accessToken).update('agent-control-session-v1').digest('base64url');

function equalText(a, b) {
  const aa = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function cookieValue(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function authorized(req) {
  return equalText(cookieValue(req, 'agent_session'), sessionValue);
}

async function bodyJson(req, max = 32 * 1024) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('request_too_large');
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
}

function sendJson(res, status, value) {
  const data = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

async function run(command, args = [], options = {}) {
  try {
    const { stdout = '', stderr = '' } = await execFileAsync(command, args, {
      cwd: options.cwd || agentRoot,
      timeout: options.timeout || 20_000,
      maxBuffer: options.maxBuffer || 2_000_000,
      env: { ...process.env, ...(options.env || {}) }
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || '').trim(),
      stderr: String(error.stderr || error.message || '').trim(),
      code: error.code ?? null
    };
  }
}

function parseJsonOutput(result, fallback) {
  if (!result.ok || !result.stdout) return fallback;
  try { return JSON.parse(result.stdout); } catch { return fallback; }
}

function requestFromIssue(issue) {
  const body = issue.body || '';
  const at = body.indexOf(marker);
  if (at < 0) return null;
  try { return JSON.parse(body.slice(at + marker.length).trim()); } catch { return null; }
}

async function getOpenTasks() {
  const result = await run('gh', ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '60',
    '--json', 'number,title,body,createdAt,updatedAt,url']);
  const issues = parseJsonOutput(result, []);
  return issues.map((issue) => ({ ...issue, request: requestFromIssue(issue) }))
    .filter((issue) => issue.request?.projectId);
}

async function getRuns() {
  const result = await run('gh', ['run', 'list', '--repo', repo, '--workflow', 'agent-cloud.yml', '--limit', '30',
    '--json', 'databaseId,status,conclusion,event,createdAt,updatedAt,displayTitle,url,headSha']);
  return parseJsonOutput(result, []);
}

async function getQueue() {
  const result = await run('node', ['src/cli.js', 'inbox', 'status'], { timeout: 30_000 });
  return { records: parseJsonOutput(result, []), error: result.ok ? null : result.stderr };
}

async function getService() {
  const active = await run('systemctl', ['--user', 'is-active', 'engineering-orchestrator-inbox.service']);
  const enabled = await run('systemctl', ['--user', 'is-enabled', 'engineering-orchestrator-inbox.service']);
  return { active: active.stdout === 'active', enabled: enabled.stdout === 'enabled', detail: active.stderr || null };
}

async function getGit() {
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const commit = await run('git', ['rev-parse', '--short=12', 'HEAD']);
  const dirty = await run('git', ['status', '--porcelain']);
  return { branch: branch.stdout, commit: commit.stdout, dirty: Boolean(dirty.stdout) };
}

async function getProcesses() {
  const result = await run('ps', ['-eo', 'pid=,etime=,cmd='], { cwd: '/', timeout: 5_000 });
  if (!result.ok) return [];
  return result.stdout.split('\n')
    .filter((line) => /src\/cli\.js|cloud-drain|codex|opencode|antigravity|engineering-orchestrator/i.test(line))
    .slice(0, 30);
}

async function getLogs(limit = 80) {
  const count = Math.max(10, Math.min(300, Number(limit) || 80));
  const result = await run('journalctl', ['--user', '-u', 'engineering-orchestrator-inbox.service',
    '-n', String(count), '--no-pager', '-o', 'short-iso'], { cwd: '/', timeout: 8_000, maxBuffer: 1_500_000 });
  return result.ok ? result.stdout.split('\n').filter(Boolean) : [result.stderr || 'No se pudieron leer los logs'];
}

async function snapshot() {
  const started = Date.now();
  const [service, git, queue, tasks, runs, processes, logs] = await Promise.all([
    getService(), getGit(), getQueue(), getOpenTasks(), getRuns(), getProcesses(), getLogs(70)
  ]);
  return {
    now: new Date().toISOString(),
    latencyMs: Date.now() - started,
    service, git, queue, tasks, runs, processes, logs,
    host: { online: true, agentRoot, repo }
  };
}

function validateTask(input) {
  const lane = String(input.lane || '').trim();
  if (!Object.hasOwn(laneScopes, lane)) throw new Error('lane_invalid');
  const goal = String(input.goal || '').trim();
  if (goal.length < 5 || goal.length > 1000) throw new Error('goal_invalid');
  const allowedPaths = Array.isArray(input.allowedPaths) && input.allowedPaths.length
    ? input.allowedPaths.map((p) => String(p).trim()).filter(Boolean)
    : laneScopes[lane];
  if (!allowedPaths.length || allowedPaths.length > 40) throw new Error('scope_invalid');
  return { lane, goal, allowedPaths };
}

async function createTask(input) {
  const { lane, goal, allowedPaths } = validateTask(input);
  const request = {
    version: 1,
    projectId: lane,
    profile: 'app-improvement',
    goal,
    scope: { allowedPaths, forbiddenPaths: [] }
  };
  const title = `[Agent][${lane}] ${goal.replace(/\s+/g, ' ').slice(0, 72)}`;
  const body = `${marker}\n${JSON.stringify(request, null, 2)}`;
  const created = await run('gh', ['issue', 'create', '--repo', repo, '--title', title, '--body', body], { timeout: 30_000 });
  if (!created.ok) throw new Error(`issue_create_failed:${created.stderr}`);
  const url = created.stdout.split(/\s+/).find((item) => /^https:\/\//.test(item)) || created.stdout;
  const match = /\/issues\/(\d+)/.exec(url);
  return { lane, goal, issueNumber: match ? Number(match[1]) : null, url };
}

async function wakeLane(lane) {
  if (!Object.hasOwn(laneScopes, lane)) throw new Error('lane_invalid');
  const result = await run('gh', ['workflow', 'run', 'agent-cloud.yml', '--repo', repo, '-f', `lane=${lane}`], { timeout: 30_000 });
  if (!result.ok) throw new Error(`workflow_dispatch_failed:${result.stderr}`);
  return { lane, dispatched: true };
}

async function approveTask(input) {
  const issue = Number(input.issueNumber);
  const decision = input.decision === 'reject' ? 'reject' : 'approve';
  const fingerprint = String(input.fingerprint || '').trim().toLowerCase();
  if (!Number.isInteger(issue) || issue < 1 || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('approval_invalid');
  const result = await run('gh', ['issue', 'comment', String(issue), '--repo', repo, '--body', `/agent ${decision} ${fingerprint}`]);
  if (!result.ok) throw new Error(`approval_failed:${result.stderr}`);
  return { issueNumber: issue, decision, sent: true };
}

async function retryRun(input) {
  const runId = Number(input.runId);
  if (!Number.isInteger(runId) || runId < 1) throw new Error('run_invalid');
  const result = await run('gh', ['run', 'rerun', String(runId), '--failed', '--repo', repo], { timeout: 30_000 });
  if (!result.ok) throw new Error(`rerun_failed:${result.stderr}`);
  return { runId, dispatched: true };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = resolve(publicDir, '.' + pathname);
  if (!file.startsWith(publicDir)) return sendJson(res, 404, { error: 'not_found' });
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not_file');
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': mime[extname(file)] || 'application/octet-stream',
      'cache-control': pathname === '/index.html' ? 'no-store' : 'public, max-age=300'
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'not_found' });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const input = await bodyJson(req);
      if (!equalText(input.pin, accessToken)) return sendJson(res, 401, { error: 'pin_incorrecto' });
      res.setHeader('set-cookie', `agent_session=${encodeURIComponent(sessionValue)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`);
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname.startsWith('/api/') && !authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && url.pathname === '/api/status') return sendJson(res, 200, await snapshot());
    if (req.method === 'GET' && url.pathname === '/api/logs') return sendJson(res, 200, { logs: await getLogs(url.searchParams.get('limit')) });
    if (req.method === 'POST' && url.pathname === '/api/task') return sendJson(res, 201, await createTask(await bodyJson(req)));
    if (req.method === 'POST' && url.pathname === '/api/wake') {
      const input = await bodyJson(req);
      return sendJson(res, 200, await wakeLane(String(input.lane || '')));
    }
    if (req.method === 'POST' && url.pathname === '/api/approve') return sendJson(res, 200, await approveTask(await bodyJson(req)));
    if (req.method === 'POST' && url.pathname === '/api/retry') return sendJson(res, 200, await retryRun(await bodyJson(req)));
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      res.setHeader('set-cookie', 'agent_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
    sendJson(res, 405, { error: 'method_not_allowed' });
  } catch (error) {
    sendJson(res, 500, { error: String(error.message || error).slice(0, 1000) });
  }
});

server.listen(port, host, () => {
  console.log(`Agent Control Center listening on http://${host}:${port}`);
  console.log(`Access token file: ${tokenFile}`);
});
