#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { criticalCiDemand, operatorRequestedLanes, planHeartbeat } from '../src/cloud-heartbeat.js';
import { syncSchedulerYieldRequests } from '../src/scheduler-yield.js';

const execFileAsync = promisify(execFile);
const repo = process.env.AGENT_REPOSITORY || 'palgarra14-del/agente-automatizador';
const workflow = process.env.AGENT_CLOUD_WORKFLOW || 'agent-cloud.yml';
const ciWorkflow = process.env.AGENT_CI_WORKFLOW || 'ci.yml';
const cli = process.execPath;
const timeoutMs = Number(process.env.AGENT_HEARTBEAT_PEEK_TIMEOUT_MS || 45_000);
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
  const runs = await run('gh',['run','list','--repo',repo,'--workflow',workflow,'--limit','20','--json','databaseId,status'],{timeout:15_000});
  if (!runs.ok) return new Set();
  let parsed;
  try { parsed=JSON.parse(runs.stdout); } catch { return new Set(); }
  const active = new Set();
  for (const item of parsed.filter((run) => run.status !== 'completed')) {
    const jobs=await run('gh',['run','view',String(item.databaseId),'--repo',repo,'--json','jobs','--jq','.jobs[].name'],{timeout:15_000});
    for (const lane of lanes) {
      if (jobs.stdout.includes(`(${lane})`)) active.add(lane);
    }
  }
  return active;
}

async function queuedCriticalCiDemand() {
  const result = await run('gh',[
    'run','list','--repo',repo,'--workflow',ciWorkflow,'--limit','20',
    '--json','name,status,event'
  ],{timeout:15_000});
  if (!result.ok) return 0;
  try {
    return Math.min(1, criticalCiDemand(JSON.parse(result.stdout)));
  } catch {
    return 0;
  }
}

async function observeLane(lane,active,operatorLanes) {
  const operatorRequested = operatorLanes.has(lane);
  if (active.has(lane)) return {lane,active:true,operatorRequested};
  const result=await run(cli,['src/cli.js','inbox','cloud-peek','--lane',lane],{timeout:timeoutMs});
  if (!result.ok) return {lane,active:false,operatorRequested,error:result.stderr || result.stdout || 'cloud_peek_failed'};
  return {lane,active:false,operatorRequested,hasWork:result.stdout.split(/\s+/).at(-1) === 'true'};
}

const config=await loadConfig();
const lanes=(config.cloudLanes ?? []).map((lane) => lane.id);
const active=await activeLanes(lanes);
const operatorLanes=new Set(operatorRequestedLanes(await openOperatorIssues(),config));
const externalPriorityDemand=await queuedCriticalCiDemand();
const observations=[];
for (const lane of lanes) observations.push(await observeLane(lane,active,operatorLanes));

const maxHeavy=Number(process.env.AGENT_MAX_HEAVY || 3);
const plan=planHeartbeat(observations,{
  maxHeavy,
  maxBusinessHeavy:Number(process.env.AGENT_MAX_BUSINESS_HEAVY || maxHeavy),
  maxSelfHeavy:Number(process.env.AGENT_MAX_SELF_HEAVY || 1),
  reserveForExternal:externalPriorityDemand
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
