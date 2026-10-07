import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  deriveControlHealth,
  summarizeGithubRateLimit,
  summarizeLaneRuns,
  summarizeRunners
} from './telemetry.mjs';
import { globalPauseEnabled, parsePausedLanes, serializePausedLanes } from '../src/operator-control.js';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, 'public');
const agentRoot = resolve(process.env.AGENT_ROOT || join(here, '..', '..', 'agente-automatizador'));
const host = process.env.AGENT_CONTROL_HOST || '127.0.0.1';
const port = Number(process.env.AGENT_CONTROL_PORT || 8787);
const repo = process.env.AGENT_CONTROL_REPO || 'palgarra14-del/agente-automatizador';
const nightModeUnit = 'agent-night-mode.service';
const tokenFile = process.env.AGENT_CONTROL_TOKEN_FILE || join(homedir(), '.config', 'agent-control-center', 'access-token');
const marker = '<!-- agent-request:v1 -->';
const cloudStatusCache = new Map();
const cloudStatusCacheMs = 45_000;
const telemetryCache = new Map();

async function cachedTelemetry(key, ttlMs, loader) {
  const now = Date.now();
  const existing = telemetryCache.get(key);
  if (existing?.value !== undefined && now - existing.at < ttlMs) return existing.value;
  if (existing?.pending) return existing.pending;
  const pending = Promise.resolve()
    .then(loader)
    .then((value) => {
      telemetryCache.set(key, { at: Date.now(), value });
      return value;
    })
    .catch((error) => {
      if (existing?.value !== undefined) {
        telemetryCache.set(key, { at: existing.at, value: existing.value, error: String(error?.message || error) });
        return existing.value;
      }
      throw error;
    });
  telemetryCache.set(key, { ...(existing || {}), pending });
  return pending;
}

function telemetryAgeMs(key) {
  const entry = telemetryCache.get(key);
  return entry?.at ? Math.max(0, Date.now() - entry.at) : null;
}

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
    if (value.length >= 5 && value.length <= 128) return value;
  } catch { /* token file does not exist yet */ }
  await mkdir(dirname(tokenFile), { recursive: true, mode: 0o700 });
  const value = randomBytes(12).toString('base64url');
  await writeFile(tokenFile, value + '\n', { mode: 0o600 });
  return value;
}

let accessToken = await ensureToken();
function deriveSessionValue(token) {
  return createHmac('sha256', token).update('agent-control-session-v1').digest('base64url');
}
let sessionValue = deriveSessionValue(accessToken);

function setSessionCookie(res) {
  res.setHeader('set-cookie', `agent_session=${encodeURIComponent(sessionValue)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`);
}

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
  return cachedTelemetry('tasks', 30_000, async () => {
    const result = await run('gh', ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '60',
      '--json', 'number,title,body,createdAt,updatedAt,url']);
    const issues = parseJsonOutput(result, []);
    return issues.map((issue) => ({ ...issue, request: requestFromIssue(issue) }))
      .filter((issue) => issue.request?.projectId);
  });
}

async function getRuns() {
  return cachedTelemetry('runs', 15_000, async () => {
    const result = await run('gh', ['run', 'list', '--repo', repo, '--workflow', 'agent-cloud.yml', '--limit', '40',
      '--json', 'databaseId,status,conclusion,event,createdAt,updatedAt,displayTitle,url,headSha']);
    return parseJsonOutput(result, []);
  });
}

async function getRunners() {
  return cachedTelemetry('runners', 30_000, async () => {
    const result = await run('gh', ['api', `repos/${repo}/actions/runners?per_page=100`], { timeout: 12_000 });
    const payload = parseJsonOutput(result, { runners: [] });
    return {
      runners: Array.isArray(payload.runners) ? payload.runners : [],
      error: result.ok ? null : (result.stderr || 'runner_telemetry_unavailable')
    };
  });
}

async function getRepoVariable(name) {
  const result = await run('gh', ['api', `repos/${repo}/actions/variables/${name}`, '--jq', '.value'], { timeout: 8_000 });
  if (result.ok) return result.stdout;
  if (/HTTP 404|Not Found/i.test(result.stderr)) return '';
  return '';
}

async function getRemoteControl() {
  const lanes = Object.keys(laneScopes);
  const [globalValue, pausedValue] = await Promise.all([
    getRepoVariable('AGENT_GLOBAL_PAUSE'),
    getRepoVariable('AGENT_PAUSED_LANES')
  ]);
  return {
    globalPaused: globalPauseEnabled(globalValue),
    pausedLanes: parsePausedLanes(pausedValue, lanes),
    mode: globalPauseEnabled(globalValue) ? 'paused' : 'autonomous'
  };
}

async function setRepoVariable(name, value) {
  const result = await run('gh', ['variable', 'set', name, '--repo', repo, '--body', String(value)], { timeout: 15_000 });
  if (!result.ok) throw new Error(`control_variable_update_failed:${result.stderr || name}`);
  return true;
}

async function wakeHeartbeat() {
  const result = await run('systemctl', ['--user', 'start', '--no-block', 'engineering-orchestrator-cloud-heartbeat.service'], { cwd:'/', timeout: 5_000 });
  if (!result.ok) throw new Error(`heartbeat_wakeup_failed:${result.stderr || 'systemctl_failed'}`);
}

async function setGlobalPause(input) {
  const paused = input?.paused === true;
  await setRepoVariable('AGENT_GLOBAL_PAUSE', paused ? 'true' : 'false');
  if (!paused) await wakeHeartbeat();
  return { ...(await getRemoteControl()), changed: true };
}

async function setLanePause(input) {
  const lane = String(input?.lane || '').trim();
  if (!Object.hasOwn(laneScopes, lane)) throw new Error('lane_invalid');
  const paused = input?.paused === true;
  const current = await getRemoteControl();
  const lanes = new Set(current.pausedLanes);
  if (paused) lanes.add(lane);
  else lanes.delete(lane);
  await setRepoVariable('AGENT_PAUSED_LANES', serializePausedLanes([...lanes]) || '-');
  if (!paused && !current.globalPaused) await wakeHeartbeat();
  return { ...(await getRemoteControl()), lane, changed: true };
}

async function getGithubRateLimit() {
  return cachedTelemetry('github-rate-limit', 30_000, async () => {
    const result = await run('gh', ['api', 'rate_limit'], { timeout: 12_000 });
    if (!result.ok) return { resources: {}, error: result.stderr || 'rate_limit_unavailable' };
    const payload = parseJsonOutput(result, { resources: {} });
    return { ...payload, error: null };
  });
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

async function getAutonomy() {
  const [heartbeat, heartbeatEnabled, designLabTimer] = await Promise.all([
    run('systemctl', ['--user', 'is-active', 'engineering-orchestrator-cloud-heartbeat.timer'], { cwd:'/', timeout:4_000 }),
    run('systemctl', ['--user', 'is-enabled', 'engineering-orchestrator-cloud-heartbeat.timer'], { cwd:'/', timeout:4_000 }),
    run('systemctl', ['--user', 'is-active', 'engineering-orchestrator-design-lab.timer'], { cwd:'/', timeout:4_000 })
  ]);
  return {
    heartbeatActive: heartbeat.stdout === 'active',
    heartbeatEnabled: heartbeatEnabled.stdout === 'enabled',
    designLabTimerActive: designLabTimer.stdout === 'active',
    heartbeatIntervalSeconds: 120
  };
}

async function getGit() {
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const commit = await run('git', ['rev-parse', '--short=12', 'HEAD']);
  const dirty = await run('git', ['status', '--porcelain']);
  return { branch: branch.stdout, commit: commit.stdout, dirty: Boolean(dirty.stdout) };
}

async function getProcessSnapshot() {
  const result = await run('ps', ['-eo', 'pid=,ppid=,etime=,cmd='], { cwd: '/', timeout: 5_000, maxBuffer: 1_500_000 });
  if (!result.ok) return { rows: [], visible: [] };
  const rows = result.stdout.split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    return match ? {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      elapsed: match[3],
      command: match[4],
      raw: line
    } : null;
  }).filter(Boolean);
  const visible = rows
    .filter((row) => /src\/cli\.js|cloud-drain|cloud-recover|model-gateway|codex|opencode|antigravity|ollama|llama-server|engineering-orchestrator/i.test(row.command))
    .slice(0, 40)
    .map((row) => row.raw);
  return { rows, visible };
}

function providerFailureCategory(reason) {
  const text = String(reason || '').toLowerCase();
  if (/quota|resource_exhausted|insufficient/.test(text)) return 'quota';
  if (/rate.?limit|429/.test(text)) return 'rate_limit';
  if (/auth|login|token|unauthorized|forbidden/.test(text)) return 'auth';
  if (/timeout|timed out|etimedout/.test(text)) return 'timeout';
  if (/unavailable|connection|refused|network|5\d\d/.test(text)) return 'service_unavailable';
  return 'unknown';
}

async function getAiHealth(processes = []) {
  const stateDir = process.env.DESIGN_LAB_STATE_DIR || join(homedir(), '.local', 'state', 'engineering-orchestrator', 'design-lab');
  const opencodeProbe = await cachedTelemetry('opencode-availability', 60_000, async () => {
    const result = await run(process.env.OPENCODE_BIN || 'opencode', ['--version'], { cwd:'/', timeout:2_000, maxBuffer:32_000 });
    return { available: result.ok, version: result.ok ? result.stdout : null };
  });
  const now = Date.now() / 1000;
  let runtime = { providers: {}, candidates: {} };
  try {
    runtime = JSON.parse(await readFile(join(stateDir, 'model-runtime-health.json'), 'utf8'));
  } catch { /* optional runtime health file */ }

  const localText = processes.join('\n').toLowerCase();
  const providers = [
    {
      id: 'antigravity',
      label: 'Antigravity',
      kind: 'cloud-free',
      local: false,
      processActive: localText.includes('antigravity')
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      kind: 'local/free',
      local: true,
      installed: opencodeProbe.available,
      version: opencodeProbe.version,
      processActive: localText.includes('opencode')
    },
    {
      id: 'ollama',
      label: 'Ollama',
      kind: 'local/free',
      local: true,
      processActive: localText.includes('ollama')
    }
  ].map((provider) => {
    const persisted = runtime.providers?.[provider.id] ?? null;
    const untilEpoch = Number(persisted?.untilEpoch || 0);
    const cooldown = untilEpoch > now;
    return {
      ...provider,
      state: cooldown
        ? 'cooldown'
        : provider.id === 'opencode'
          ? (provider.installed ? 'available' : 'offline')
          : (provider.local ? (provider.processActive ? 'available' : 'offline') : 'available'),
      reasonCategory: cooldown ? providerFailureCategory(persisted?.reason) : null,
      cooldownUntil: cooldown ? new Date(untilEpoch * 1000).toISOString() : null,
      retryInSeconds: cooldown ? Math.max(0, Math.ceil(untilEpoch - now)) : 0
    };
  });

  let lastModel = null;
  const performanceTail = await run('tail', ['-n', '80', join(stateDir, 'model-performance.jsonl')], {
    cwd: '/',
    timeout: 2_000,
    maxBuffer: 250_000
  });
  if (performanceTail.ok) {
    const lines = performanceTail.stdout.split('\n').filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const record = JSON.parse(lines[index]);
        if (record?.candidate && record?.provider) {
          lastModel = {
            recordedAt: record.recordedAt ?? null,
            role: record.role ?? null,
            candidate: record.candidate,
            provider: record.provider,
            model: record.model ?? null,
            success: record.success === true,
            runId: record.runId ?? null
          };
          break;
        }
      } catch { /* ignore malformed historical line */ }
    }
  }

  return { providers, lastModel };
}

function getWorkActivity(rows = []) {
  const childrenByParent = new Map();
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) || [];
    children.push(row);
    childrenByParent.set(row.ppid, children);
  }
  const descendants = (pid) => {
    const result = [];
    const queue = [...(childrenByParent.get(pid) || [])];
    while (queue.length) {
      const child = queue.shift();
      result.push(child);
      queue.push(...(childrenByParent.get(child.pid) || []));
    }
    return result;
  };

  const seen = new Set();
  const activity = [];
  for (const row of rows) {
    const match = /(?:^|\s)node\s+src\/cli\.js\s+inbox\s+(cloud-[a-z-]+)\s+--lane\s+([a-z0-9-]+)/i.exec(row.command);
    if (!match) continue;
    const [, action, lane] = match;
    const key = lane + ':' + action;
    if (seen.has(key)) continue;
    seen.add(key);
    const tree = descendants(row.pid);
    const commands = tree.map((item) => item.command.toLowerCase());
    const backend = commands.some((command) => command.includes('antigravity'))
      ? 'Antigravity'
      : commands.some((command) => command.includes('opencode'))
        ? 'OpenCode'
        : commands.some((command) => command.includes('llama-server') || command.includes('ollama'))
          ? 'Ollama'
          : commands.some((command) => command.includes('model-gateway.py'))
            ? 'model-gateway'
            : null;
    activity.push({
      pid: row.pid,
      elapsed: row.elapsed,
      action,
      lane,
      backend,
      modelGatewayActive: commands.some((command) => command.includes('model-gateway.py'))
    });
  }
  return activity;
}

function refreshCloudStatus(lane) {
  const existing = cloudStatusCache.get(lane) || {};
  if (existing.pending) return;
  const pending = (async () => {
    const result = await run('node', ['src/cli.js', 'inbox', 'cloud-status', '--lane', lane], { timeout: 12_000 });
    if (!result.ok) {
      cloudStatusCache.set(lane, {
        at: Date.now(),
        value: existing.value ?? null,
        error: 'cloud_status_unavailable'
      });
      return;
    }
    const value = parseJsonOutput(result, { current: null, latest: null, records: [] });
    cloudStatusCache.set(lane, {
      at: Date.now(),
      value: {
        current: value.current ?? null,
        latest: value.latest ?? null,
        records: Array.isArray(value.records) ? value.records : []
      },
      error: null
    });
  })().catch(() => {
    cloudStatusCache.set(lane, {
      at: Date.now(),
      value: existing.value ?? null,
      error: 'cloud_status_unavailable'
    });
  });
  cloudStatusCache.set(lane, { ...existing, pending });
}

function getCloudOperations(workActivity = []) {
  const lanes = [...new Set(workActivity.map((item) => item.lane).filter((lane) => Object.hasOwn(laneScopes, lane)))];
  const now = Date.now();
  return lanes.map((lane) => {
    const worker = workActivity.find((item) => item.lane === lane) ?? null;
    const cached = cloudStatusCache.get(lane);
    const stale = !cached?.at || now - cached.at >= cloudStatusCacheMs;
    if (stale && !cached?.pending) refreshCloudStatus(lane);
    const latestCache = cloudStatusCache.get(lane) || {};
    return {
      lane,
      worker,
      current: latestCache.value?.current ?? null,
      latest: latestCache.value?.latest ?? null,
      records: latestCache.value?.records ?? [],
      error: latestCache.error ?? null,
      loading: Boolean(latestCache.pending && !latestCache.value),
      cached: Boolean(latestCache.value)
    };
  });
}

async function getLogs(limit = 80) {
  const count = Math.max(10, Math.min(300, Number(limit) || 80));
  const result = await run('journalctl', ['--user', '-u', 'engineering-orchestrator-inbox.service',
    '-n', String(count), '--no-pager', '-o', 'short-iso'], { cwd: '/', timeout: 8_000, maxBuffer: 1_500_000 });
  return result.ok ? result.stdout.split('\n').filter(Boolean) : [result.stderr || 'No se pudieron leer los logs'];
}

async function snapshot() {
  const started = Date.now();
  const [service, autonomy, git, queue, tasks, runs, runnerSource, rateLimitSource, processSnapshot, logs, remoteControl, nightMode] = await Promise.all([
    getService(), getAutonomy(), getGit(), getQueue(), getOpenTasks(), getRuns(), getRunners(), getGithubRateLimit(), getProcessSnapshot(), getLogs(70), getRemoteControl(), getNightMode()
  ]);
  const processes = processSnapshot.visible;
  const aiHealth = await getAiHealth(processes);
  const workActivity = getWorkActivity(processSnapshot.rows);
  const cloudOperations = await getCloudOperations(workActivity);
  const laneTelemetry = summarizeLaneRuns(runs);
  const runnerTelemetry = summarizeRunners(runnerSource.runners);
  const githubRateLimit = summarizeGithubRateLimit(rateLimitSource);
  const controlHealth = deriveControlHealth({ service, queue, runnerTelemetry, rateLimit: githubRateLimit, laneTelemetry, remoteControl });
  return {
    now: new Date().toISOString(),
    latencyMs: Date.now() - started,
    service, autonomy, git, queue, tasks, runs, processes, logs, aiHealth, workActivity, cloudOperations, remoteControl, nightMode,
    laneTelemetry,
    runnerTelemetry: { ...runnerTelemetry, error: runnerSource.error },
    githubRateLimit: { ...githubRateLimit, error: rateLimitSource.error },
    controlHealth,
    telemetry: {
      tasksAgeMs: telemetryAgeMs('tasks'),
      runsAgeMs: telemetryAgeMs('runs'),
      runnersAgeMs: telemetryAgeMs('runners'),
      rateLimitAgeMs: telemetryAgeMs('github-rate-limit')
    },
    host: { online: true, agentRoot, repo }
  };
}

function validateTask(input) {
  const lane = String(input.lane || '').trim();
  if (!Object.hasOwn(laneScopes, lane)) throw new Error('lane_invalid');
  const goal = String(input.goal || '').trim();
  if (goal.length < 5 || goal.length > 1000) throw new Error('goal_invalid');
  const profile = input.profile === 'website-build' ? 'website-build' : 'app-improvement';
  if (profile === 'website-build' && lane !== 'website-pilot') throw new Error('website_build_lane_invalid');
  const priority = String(input.priority || 'normal').trim().toLowerCase();
  if (!['low', 'normal', 'high'].includes(priority)) throw new Error('priority_invalid');
  const allowedPaths = Array.isArray(input.allowedPaths) && input.allowedPaths.length
    ? input.allowedPaths.map((p) => String(p).trim()).filter(Boolean)
    : laneScopes[lane];
  if (!allowedPaths.length || allowedPaths.length > 40) throw new Error('scope_invalid');
  let businessBrief = null;
  if (profile === 'website-build') {
    const source = input.businessBrief || {};
    const businessName = String(source.businessName || '').trim();
    const category = String(source.category || '').trim();
    const location = String(source.location || '').trim();
    const services = String(source.services || '').split(/[\n,]+/).map((v) => v.trim()).filter(Boolean);
    if (!businessName || !category || !location || !services.length) throw new Error('business_brief_incomplete');
    businessBrief = {
      version: 1, businessName, category, summary: goal, locations: [location],
      services, contact: {}, brand: {},
      website: { primaryGoal: 'Conseguir contactos', requiredPages: ['home','services','contact'], requiredFeatures: [] },
      facts: [], contentRestrictions: [], assets: {}
    };
  }
  return { lane, goal, allowedPaths, profile, priority, businessBrief };
}

async function createTask(input) {
  const { lane, goal, allowedPaths, profile, priority, businessBrief } = validateTask(input);
  const request = {
    version: 1,
    projectId: lane,
    profile,
    priority,
    goal,
    scope: { allowedPaths, forbiddenPaths: [] },
    ...(businessBrief ? { input: { businessBrief } } : {})
  };
  const title = `[Agent][${lane}] ${goal.replace(/\s+/g, ' ').slice(0, 72)}`;
  const body = `${marker}\n${JSON.stringify(request, null, 2)}`;
  const created = await run('gh', ['issue', 'create', '--repo', repo, '--title', title, '--body', body], { timeout: 30_000 });
  if (!created.ok) throw new Error(`issue_create_failed:${created.stderr}`);
  const url = created.stdout.split(/\s+/).find((item) => /^https:\/\//.test(item)) || created.stdout;
  const match = /\/issues\/(\d+)/.exec(url);
  return { lane, goal, priority, issueNumber: match ? Number(match[1]) : null, url };
}

async function wakeLane(lane) {
  if (!Object.hasOwn(laneScopes, lane)) throw new Error('lane_invalid');
  const result = await run('gh', ['workflow', 'run', 'agent-cloud.yml', '--repo', repo, '-f', `lane=${lane}`], { timeout: 30_000 });
  if (!result.ok) throw new Error(`workflow_dispatch_failed:${result.stderr}`);
  return { lane, dispatched: true };
}

async function restartAgentService() {
  const result = await run('systemctl', ['--user', 'restart', 'engineering-orchestrator-inbox.service'], { cwd: '/', timeout: 30_000 });
  if (!result.ok) throw new Error(`service_restart_failed:${result.stderr}`);
  const active = await run('systemctl', ['--user', 'is-active', 'engineering-orchestrator-inbox.service'], { cwd: '/' });
  return { restarted: true, active: active.stdout === 'active' };
}

async function getNightMode() {
  const active = await run('systemctl', ['--user', 'is-active', nightModeUnit], { cwd:'/', timeout:4_000 });
  return {
    active: active.stdout === 'active',
    unit: nightModeUnit,
    behavior: { preventsSuspend:true, locksSession:true, displayOff:true, closesApps:false }
  };
}

async function hyprDispatch(expression) {
  return run('/usr/bin/hyprctl', ['-i', '0', 'dispatch', expression], {
    cwd:'/',
    timeout:5_000,
    env: { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || ('/run/user/' + process.getuid()) }
  });
}

async function setNightMode(input) {
  if (typeof input?.enabled !== 'boolean') throw new Error('night_mode_enabled_invalid');

  if (input.enabled) {
    const started = await run('systemctl', ['--user', 'start', nightModeUnit], { cwd:'/', timeout:8_000 });
    if (!started.ok) throw new Error('night_mode_inhibitor_start_failed:' + (started.stderr || started.stdout));

    const locked = await hyprDispatch('hl.dsp.global("caelestia:lock")');
    if (!locked.ok) {
      await run('systemctl', ['--user', 'stop', nightModeUnit], { cwd:'/', timeout:8_000 });
      throw new Error('night_mode_lock_failed:' + (locked.stderr || locked.stdout));
    }

    const display = await hyprDispatch('hl.dsp.dpms(false)');
    if (!display.ok) {
      await run('systemctl', ['--user', 'stop', nightModeUnit], { cwd:'/', timeout:8_000 });
      throw new Error('night_mode_display_off_failed:' + (display.stderr || display.stdout));
    }
  } else {
    const stopped = await run('systemctl', ['--user', 'stop', nightModeUnit], { cwd:'/', timeout:8_000 });
    if (!stopped.ok) throw new Error('night_mode_inhibitor_stop_failed:' + (stopped.stderr || stopped.stdout));
    const display = await hyprDispatch('hl.dsp.dpms(true)');
    if (!display.ok) throw new Error('night_mode_display_on_failed:' + (display.stderr || display.stdout));
  }

  return getNightMode();
}


async function changeAccessPin(input) {
  const pin = String(input?.pin ?? '').trim();
  if (pin.length < 5 || pin.length > 128 || /[\r\n\0]/.test(pin)) throw new Error('pin_invalid');
  await mkdir(dirname(tokenFile), { recursive:true, mode:0o700 });
  await writeFile(tokenFile, pin + '\n', { mode:0o600 });
  accessToken = pin;
  sessionValue = deriveSessionValue(pin);
  return { changed:true };
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

async function cancelTask(input) {
  const workflowId = String(input.workflowId || '').trim();
  if (!/^workflow-[a-z0-9-]{8,120}$/i.test(workflowId)) throw new Error('workflow_invalid');
  const queue = await getQueue();
  if (queue.error) throw new Error(`queue_unavailable:${queue.error}`);
  const record = (queue.records || []).find((item) => item.workflowId === workflowId);
  if (!record) throw new Error('workflow_not_in_queue');
  if (['completed', 'failed', 'blocked', 'rejected'].includes(record.status)) throw new Error('workflow_already_terminal');
  const result = await run('node', ['src/cli.js', 'workflow', 'cancel', workflowId, '--reason', 'workflow_cancelled_by_control_center'], { timeout: 30_000 });
  if (!result.ok) throw new Error(`workflow_cancel_failed:${result.stderr}`);
  return { issueNumber: record.issueNumber, workflowId, cancellationRequested: true };
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
      setSessionCookie(res);
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
    if (req.method === 'POST' && url.pathname === '/api/restart-service') return sendJson(res, 200, await restartAgentService());
    if (req.method === 'POST' && url.pathname === '/api/control/global') return sendJson(res, 200, await setGlobalPause(await bodyJson(req)));
    if (req.method === 'POST' && url.pathname === '/api/control/lane') return sendJson(res, 200, await setLanePause(await bodyJson(req)));
    if (req.method === 'POST' && url.pathname === '/api/control/night-mode') return sendJson(res, 200, await setNightMode(await bodyJson(req)));
    if (req.method === 'POST' && url.pathname === '/api/change-pin') {
      const result = await changeAccessPin(await bodyJson(req));
      setSessionCookie(res);
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/approve') return sendJson(res, 200, await approveTask(await bodyJson(req)));
    if (req.method === 'POST' && url.pathname === '/api/retry') return sendJson(res, 200, await retryRun(await bodyJson(req)));
    if (req.method === 'POST' && url.pathname === '/api/cancel-task') return sendJson(res, 200, await cancelTask(await bodyJson(req)));
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
