#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { heartbeatObservationOrder, heartbeatRunLane, operatorRequestedLanes, planHeartbeat } from '../src/cloud-heartbeat.js';
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

async function run(command,args,options={}) {
  try {
    const {stdout='',stderr=''} = await execFileAsync(command,args,{timeout:options.timeout ?? 30_000,maxBuffer:2_000_000});
    return {ok:true,stdout:stdout.trim(),stderr:stderr.trim()};
  } catch (error) {
    return {ok:false,stdout:String(error.stdout||'').trim(),stderr:String(error.stderr||error.message||'').trim()};
  }
}

async function loadConfig() {
  return JSON.parse(await readFile(new URL('../config/issue-queue.json', import.meta.url),'utf8'));
}

async function openOperatorIssues() {
  const result = await run('gh',[
    'issue','list','--repo',repo,'--state','open','--limit','100',
    '--json','number,author,body'
  ],{timeout:15_000});
  if (!result.ok) return [];
  try { return JSON.parse(result.stdout); } catch { return []; }
}

async function activeLanes(lanes) {
  const runs = await run('gh',['run','list','--repo',repo,'--workflow',workflow,'--limit','20','--json','databaseId,status,displayTitle,event'],{timeout:15_000});
  if (!runs.ok) return new Set();
  let parsed;
  try { parsed=JSON.parse(runs.stdout); } catch { return new Set(); }
  const active = new Set();
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

async function observeLane(lane,active,operatorLanes,peekTimeoutMs=timeoutMs) {
  const operatorRequested = operatorLanes.has(lane);
  if (active.has(lane)) return {lane,active:true,operatorRequested};
  const result=await run(cli,['src/cli.js','inbox','cloud-peek','--lane',lane],{timeout:peekTimeoutMs});
  if (!result.ok) return {lane,active:false,operatorRequested,error:result.stderr || result.stdout || 'cloud_peek_failed'};
  return {lane,active:false,operatorRequested,hasWork:result.stdout.split(/\s+/).at(-1) === 'true'};
}

const config=await loadConfig();
const lanes=(config.cloudLanes ?? []).map((lane) => lane.id);
const active=await activeLanes(lanes);
const operatorLanes=new Set(operatorRequestedLanes(await openOperatorIssues(),config));
const observations=[];
const observationStartedAt=Date.now();
for (const lane of heartbeatObservationOrder(lanes,operatorLanes)) {
  if (active.has(lane)) {
    observations.push(await observeLane(lane,active,operatorLanes,1_000));
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
  observations.push(await observeLane(lane,active,operatorLanes,Math.min(timeoutMs,remainingMs)));
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

const dispatched=[];
for (const item of plan.dispatch) {
  if (dryRun) {
    dispatched.push({...item,ok:true,dryRun:true,error:null});
    continue;
  }
  const result=await run('gh',['workflow','run',workflow,'--repo',repo,'-f',`lane=${item.lane}`],{timeout:30_000});
  dispatched.push({...item,ok:result.ok,dryRun:false,error:result.ok?null:(result.stderr||result.stdout)});
}

console.log(JSON.stringify({...plan,yieldRequests,dryRun,dispatched},null,2));
if (dispatched.some((item)=>!item.ok)) process.exitCode=1;
