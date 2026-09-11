#!/usr/bin/env node
import { resolve } from 'node:path';
import { JsonStore, Orchestrator, WorkflowEngine, doctor, formatDoctor, loadProjects, maskSecrets, report } from './core.js';
import { defaultToolSkillRegistry } from './capabilities.js';
import { defaultSpecialistRegistry } from './specialists.js';

const args = process.argv.slice(2);
const take = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const has = (name) => args.includes(name);
const takeAll = (name) => args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]] : []);
const command = args[0];
const store = new JsonStore(resolve('.agent/state.json'));
const projects = await loadProjects(resolve('config/projects.json'));
const orchestrator = new Orchestrator({ store });
const workflows = new WorkflowEngine({ store, projects });

try {
  if (command === 'run') {
    const project = projects.get(take('--project'));
    if (!project) throw new Error('Unknown --project');
    console.log(report(await orchestrator.run(project, take('--goal') ?? 'Make a small safe change', {
      dryRun: has('--dry-run'),
      requestAction: take('--request-action'),
      allowedPaths: takeAll('--allowed-path'),
      forbiddenPaths: takeAll('--forbidden-path')
    })));
  } else if (command === 'capabilities') {
    const project = projects.get(take('--project'));
    if (!project) throw new Error('Unknown --project');
    const surface = take('--surface') ?? 'workflow';
    console.log(JSON.stringify(defaultToolSkillRegistry.report(project, { surface }), null, 2));
  } else if (command === 'specialists') {
    const project = projects.get(take('--project'));
    if (!project) throw new Error('Unknown --project');
    const surface = take('--surface') ?? 'workflow';
    console.log(JSON.stringify(defaultSpecialistRegistry.report(project, { capabilityRegistry: defaultToolSkillRegistry, surface }), null, 2));
  } else if (command === 'doctor') {
    const project = projects.get(take('--project'));
    if (!project) throw new Error('Unknown --project');
    console.log(formatDoctor(await doctor(project)));
  } else if (command === 'report') {
    const run = await store.getRun(args[1]);
    if (!run) throw new Error('Run not found');
    console.log(report(run));
  } else if (command === 'resume') {
    const run = await store.getRun(args[1]);
    if (!run) throw new Error('Run not found');
    const project = projects.get(run.projectId);
    if (!project) throw new Error('Saved run references an unknown project');
    console.log(report(await orchestrator.resume(run.id, project)));
  } else if (command === 'approvals') {
    console.log(JSON.stringify(Object.values((await store.load()).approvals), null, 2));
  } else if (command === 'approve' || command === 'reject') {
    await orchestrator.decideApproval(args[1], command === 'approve');
    console.log(`${command}d ${args[1]}`);
  } else if (command === 'workflow') {
    const action = args[1];
    if (action === 'create') {
      const project = projects.get(take('--project'));
      if (!project) throw new Error('Unknown --project');
      console.log(JSON.stringify(await workflows.create({
        profile: args[2],
        projectId: project.id,
        goal: take('--goal') ?? 'Untitled workflow',
        scope: { allowedPaths: takeAll('--allowed-path'), forbiddenPaths: takeAll('--forbidden-path') }
      }), null, 2));
    } else if (action === 'run') {
      console.log(JSON.stringify(await workflows.run(args[2], { dryRun: has('--dry-run') }), null, 2));
    } else if (action === 'status') {
      const workflow = await workflows.get(args[2]);
      if (!workflow) throw new Error('Workflow not found');
      console.log(JSON.stringify(workflow, null, 2));
    } else if (action === 'resume') {
      console.log(JSON.stringify(await workflows.resume(args[2], { dryRun: has('--dry-run') }), null, 2));
    } else if (action === 'approve') {
      console.log(JSON.stringify(await workflows.approve(args[2], args[3]), null, 2));
    } else if (action === 'list') {
      console.log(JSON.stringify(await workflows.list(), null, 2));
    } else throw new Error('Usage: agent workflow create <website-build|app-improvement|data-analysis> --project <id> --goal "..." [--allowed-path path] [--forbidden-path path] | run <id> [--dry-run] | status <id> | resume <id> | approve <id> <step-id> | list');
  } else {
    console.log('Usage: agent capabilities --project leadfinder [--surface workflow|orchestrator] | agent specialists --project leadfinder [--surface workflow|orchestrator] | agent doctor --project leadfinder | agent run --project leadfinder --goal "..." [--dry-run] [--allowed-path app] [--forbidden-path docs] | agent resume <runId> | agent report <runId> | agent approvals | agent approve <id>');
  }
} catch (error) {
  console.error(maskSecrets(error.stack ?? error.message));
  process.exitCode = 1;
}
