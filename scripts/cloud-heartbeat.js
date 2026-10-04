#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { heartbeatControlAuthUnavailable, heartbeatExecutionMode, heartbeatObservationOrder, heartbeatRunLane, localCloudUnitName, operatorRequestedLanes, planHeartbeat } from '../src/cloud-heartbeat.js';
import { globalPauseEnabled, parsePausedLanes } from '../src/operator-control.js';
import { syncSchedulerYieldRequests } from '../src/scheduler-yield.js';

const execFileAsync = promisify(execFile);
const repo = process.env.AGENT_REPOSITORY || 'palgarra14-del/agente-automatizador';
const workflow = process.env.AGENT_CLOUD_WORKFLOW || 'agent-cloud.yml';
const cli = process.execPath;
function boundedDuration(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name.toLowerCase()}_invalid`);
  return Math.round(value);
}

const timeoutMs = boundedDuration('AGENT_HEARTBEAT_PEEK_TIMEOUT_MS', 20_000, 1_000, 60_000);
const observationBudgetMs = boundedDuration('AGENT_HEARTBEAT_OBSERVATION_BUDGET_MS', 35_000, 5_000, 120_000);
const dryRun = ['1','true','yes','on'].includes(String(process.env.AGENT_HEARTBEAT_DRY_RUN || '').toLowerCase());
const executionMode = heartbeatExecutionMode(process.env.AGENT_HEARTBEAT_EXECUTION_MODE || 'cloud');

async function run(command,args,options={}) {
  try {
    const {stdout='',stderr=''} = await execFileAsync(command,args,{timeout:options.timeout ?? 30_000,maxBuffer:2_000_000});
    return {ok:true,stdout:stdout.trim(),stderr:stderr.trim(),timedOut:false};
  } catch (error) {
    return {
      ok:false,
      stdout:String(error.stdout||'').trim(),
      stderr:String(error.stderr||error.message||'').trim(),
      timedOut:error?.killed === true && Boolean(error?.signal)
    };
  }
}

async function loadConfig() {
  return JSON.parse(await readFile(new URL('../config/issue-queue.json', import.meta.url),'utf8'));
}

async function githubVariable(name) {
  const result = await run('gh', ['api', `repos/${repo}/actions/variables/${name}`, '--jq', '.value'], { timeout: 8_000 });
  return result.ok ? result.stdout : '';
}

async function loadOperatorControl(lanes) {
  const [globalValue, pausedValue] = await Promise.all([
    githubVariable('AGENT_GLOBAL_PAUSE'),
    githubVariable('AGENT_PAUSED_LANES')
  ]);
  return {
    globalPause: globalPauseEnabled(globalValue),
    pausedLanes: parsePausedLanes(pausedValue, lanes)
  };
}

async function openOperatorIssues() {
  const result = await run('gh',[
    'issue','list','--repo',repo,'--state','open','--limit','100',
    '--json','number,author,body'
  ],{timeout:15_000});
  if (!result.ok) return [];
  try { return JSON.parse(result.stdout); } catch { return []; }
}

async function rateLimitCooldownLanes(lanes) {
  if (executionMode === 'local-primary') return new Set();
  const states = await Promise.all(lanes.map(async (lane) => {
    const result = await run('systemctl', ['--user', 'is-active', `agent-cloud-retry-${lane}.timer`], { timeout: 3_000 });
    return result.ok && ['active', 'activating'].includes(result.stdout) ? lane : null;
  }));
  return new Set(states.filter(Boolean));
}

async function localActiveLanes(lanes) {
  if (executionMode !== 'local-primary') return new Set();
  const states = await Promise.all(lanes.map(async (lane) => {
    const result = await run('systemctl', ['--user', 'is-active', `${localCloudUnitName(lane)}.service`], { timeout: 3_000 });
    return result.ok && ['active', 'activating'].includes(result.stdout) ? lane : null;
  }));
  return new Set(states.filter(Boolean));
}

async function activeLanes(lanes) {
  const active = await localActiveLanes(lanes);
  const runs = await run('gh',['run','list','--repo',repo,'--workflow',workflow,'--limit','20','--json','databaseId,status,displayTitle,event'],{timeout:15_000});
  if (!runs.ok) return active;
  let parsed;
  try { parsed=JSON.parse(runs.stdout); } catch { return active; }
  for (const item of parsed.filter((run) => run.status !== 'completed')) {
    const dispatchedLane=heartbeatRunLane(item,lanes);
    if (dispatchedLane) {
      active.add(dispatchedLane);
      continue;
    }
    const jobs=await run('gh',['run','view',String(item.databaseId),'--repo',repo,'--json','jobs','--jq','.jobs[].name'],{timeout:15_000});
    for (const lane of lanes) {
      if (jobs.stdout.includes(`(${lane})`)) active.add(lane);
    }
  }
  return active;
}

async function observeLane(lane,active,cooldown,operatorLanes,peekTimeoutMs=timeoutMs) {
  const operatorRequested = operatorLanes.has(lane);
  if (active.has(lane)) return {lane,active:true,operatorRequested};
  if (cooldown.has(lane)) return {lane,active:false,operatorRequested,rateLimitCooldown:true};
  const result=await run(cli,['src/cli.js','inbox','cloud-peek','--lane',lane],{timeout:peekTimeoutMs});
  if (result.timedOut) return {lane,active:false,operatorRequested,observationSkipped:true};
  if (!result.ok) {
    const error = result.stderr || result.stdout || 'cloud_peek_failed';
    if (executionMode === 'local-primary' && heartbeatControlAuthUnavailable(error)) {
      return {lane,active:false,operatorRequested,controlUnavailable:true};
    }
    return {lane,active:false,operatorRequested,error};
  }
  return {lane,active:false,operatorRequested,hasWork:result.stdout.split(/\s+/).at(-1) === 'true'};
}

const config=await loadConfig();
const allLanes=(config.cloudLanes ?? []).map((lane) => lane.id);
const operatorControl=await loadOperatorControl(allLanes);
const lanes=operatorControl.globalPause
  ? []
  : allLanes.filter((lane) => !operatorControl.pausedLanes.includes(lane));
if (!lanes.length) {
  console.log(JSON.stringify({
    version:1,
    dispatch:[],
    deferred:[],
    yieldCandidates:[],
    yieldRequests:[],
    dryRun,
    dispatched:[],
    operatorControl
  },null,2));
  process.exit(0);
}
const [active, cooldown, operatorIssues] = await Promise.all([
  activeLanes(lanes),
  rateLimitCooldownLanes(lanes),
  openOperatorIssues()
]);
const operatorLanes=new Set(operatorRequestedLanes(operatorIssues,config));
const observations=[];
const observationStartedAt=Date.now();
const observationRotation = Math.floor(Date.now() / 60_000);
for (const lane of heartbeatObservationOrder(lanes,operatorLanes,observationRotation)) {
  if (active.has(lane)) {
    observations.push(await observeLane(lane,active,cooldown,operatorLanes,1_000));
    continue;
  }
  const remainingMs=observationBudgetMs-(Date.now()-observationStartedAt);
  if (remainingMs < 1_000) {
    observations.push({
      lane,
      active:false,
      operatorRequested:operatorLanes.has(lane),
      observationSkipped:true
    });
    continue;
  }
  observations.push(await observeLane(lane,active,cooldown,operatorLanes,Math.min(timeoutMs,remainingMs)));
}

const maxHeavy=Number(process.env.AGENT_MAX_HEAVY || 3);
const plan=planHeartbeat(observations,{
  maxHeavy,
  maxBusinessHeavy:Number(process.env.AGENT_MAX_BUSINESS_HEAVY || maxHeavy),
  maxSelfHeavy:Number(process.env.AGENT_MAX_SELF_HEAVY || 1)
});

const yieldRequests = dryRun
  ? plan.yieldCandidates.map((item) => item.lane)
  : await syncSchedulerYieldRequests(lanes, plan.yieldCandidates);

async function dispatchLane(item) {
  if (executionMode === 'local-primary') {
    const unit = localCloudUnitName(item.lane);
    const result = await run('systemd-run', [
      '--user',
      `--unit=${unit}`,
      '--collect',
      '--property=RuntimeMaxSec=25min',
      '--property=TimeoutStopSec=30s',
      `--property=WorkingDirectory=${process.cwd()}`,
      process.execPath,
      'scripts/local-cloud-drain.js',
      '--lane',
      item.lane
    ], { timeout: 10_000 });
    if (result.ok) return {...item,ok:true,dryRun:false,mode:'local-primary',error:null};

    const fallback = await run('gh',['workflow','run',workflow,'--repo',repo,'-f',`lane=${item.lane}`],{timeout:30_000});
    return {
      ...item,
      ok:fallback.ok,
      dryRun:false,
      mode:'cloud-fallback',
      localError:result.stderr || result.stdout || 'local_dispatch_failed',
      error:fallback.ok ? null : (fallback.stderr || fallback.stdout)
    };
  }

  const result=await run('gh',['workflow','run',workflow,'--repo',repo,'-f',`lane=${item.lane}`],{timeout:30_000});
  return {...item,ok:result.ok,dryRun:false,mode:'cloud',error:result.ok?null:(result.stderr||result.stdout)};
}

const dispatched=[];
for (const item of plan.dispatch) {
  if (dryRun) {
    dispatched.push({...item,ok:true,dryRun:true,mode:executionMode,error:null});
    continue;
  }
  dispatched.push(await dispatchLane(item));
}

console.log(JSON.stringify({...plan,yieldRequests,dryRun,executionMode,dispatched,operatorControl,rateLimitCooldown:[...cooldown],controlFallback:plan.classified.some((item)=>item.reason==='local_control_auth_unavailable')?'scheduled-cloud':null},null,2));
if (dispatched.some((item)=>!item.ok)) process.exitCode=1;
