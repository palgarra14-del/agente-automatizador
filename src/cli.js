#!/usr/bin/env node
import { resolve } from 'node:path';
import { JsonStore, Orchestrator, loadProjects, maskSecrets, report } from './core.js';

const args = process.argv.slice(2);
const take = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const has = (name) => args.includes(name);
const command = args[0];
const store = new JsonStore(resolve('.agent/state.json'));
const projects = await loadProjects(resolve('config/projects.json'));
const orchestrator = new Orchestrator({ store });

try {
  if (command === 'run') {
    const project = projects.get(take('--project'));
    if (!project) throw new Error('Unknown --project');
    console.log(report(await orchestrator.run(project, take('--goal') ?? 'Make a small safe change', {
      dryRun: has('--dry-run'),
      requestAction: take('--request-action')
    })));
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
  } else {
    console.log('Usage: agent run --project self --goal "..." [--dry-run] | agent resume <runId> | agent report <runId> | agent approvals | agent approve <id>');
  }
} catch (error) {
  console.error(maskSecrets(error.stack ?? error.message));
  process.exitCode = 1;
}
