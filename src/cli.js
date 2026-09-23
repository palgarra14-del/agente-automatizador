#!/usr/bin/env node
import { resolve } from 'node:path';
import { JsonStore, Orchestrator, WorkflowEngine, doctor, formatDoctor, loadProjects, maskSecrets, readBoundedRegularFile, report } from './core.js';
import { DurableCloudWorkflowEngine } from './cloud-workflow-engine.js';
import { defaultToolSkillRegistry } from './capabilities.js';
import { defaultSpecialistRegistry } from './specialists.js';
import { GitHubIssueChannel, SupervisedIssueQueue, loadIssueQueueConfig, watchIssueQueue } from './issue-queue.js';
import { autoUpgradeInboxService, ensureGitHubToken, installInboxService, readCheckoutRevision, restartInboxService, serviceStatus, syncInboxService, uninstallInboxService, upgradeInboxService } from './service.js';
import { syncWslWakeup, uninstallWslWakeup, wslWakeupStatus } from './wsl-wakeup.js';
import { projectRuntimeStatus, syncProjectRuntimes } from './runtime.js';
import { GitHubStateStore } from './cloud-state.js';
import { AutonomousSelfImprovement } from './self-improvement.js';

const args = process.argv.slice(2);
const take = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const has = (name) => args.includes(name);
const takeAll = (name) => args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]] : []);
const command = args[0];
const githubRequired = command === 'run' || command === 'resume' ||
  (command === 'inbox' && (args[1] ?? 'once') !== 'status') ||
  (command === 'workflow' && ['run', 'resume'].includes(args[1]));
if (githubRequired) await ensureGitHubToken();
if (command === 'doctor') {
  try { await ensureGitHubToken(); } catch { /* Doctor reports missing connectivity instead of failing. */ }
}

const store = new JsonStore(resolve('.agent/state.json'));
const projects = await loadProjects(resolve('config/projects.json'));
const orchestrator = new Orchestrator({ store });
const workflows = new WorkflowEngine({ store, projects });

async function loadWorkflowInput(profile) {
  const briefPath = take('--brief');
  if (profile !== 'website-build') {
    if (briefPath) throw new Error('--brief is only supported for website-build workflows');
    return undefined;
  }
  if (!briefPath) throw new Error('website-build requires --brief <business-brief.json>');
  const target = resolve(briefPath);
  let parsed;
  try {
    const content = await readBoundedRegularFile(target, { maxBytes: 64 * 1024, label: 'Business brief' });
    parsed = JSON.parse(content.toString('utf8'));
  } catch (error) {
    if (/^Business brief (?:must|exceeds|changed)/.test(error.message)) throw error;
    throw new Error(`Invalid business brief JSON: ${error.message}`, { cause: error });
  }
  return { businessBrief: parsed };
}

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
  } else if (command === 'runtime') {
    const action = args[1] ?? 'status';
    const registeredProjects = [...projects.values()];
    if (action === 'status') console.log(JSON.stringify(await projectRuntimeStatus(registeredProjects), null, 2));
    else if (action === 'sync') console.log(JSON.stringify(await syncProjectRuntimes(registeredProjects), null, 2));
    else throw new Error('Usage: agent runtime <status|sync>');
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
  } else if (command === 'inbox') {
    const action = args[1] ?? 'once';
    if (action === 'status') {
      const requests = Object.values((await store.load()).requests ?? {}).map((record) => ({
        issueNumber: record.issueNumber,
        workflowId: record.workflowId,
        status: record.status,
        reason: record.reason,
        pendingApproval: record.pendingApproval ? {
          kind: record.pendingApproval.kind,
          stepId: record.pendingApproval.stepId,
          fingerprint: record.pendingApproval.fingerprint
        } : null,
        publication: record.publication ?? null,
        updatedAt: record.updatedAt
      }));
      console.log(JSON.stringify(requests, null, 2));
    } else {
      const queueConfig = await loadIssueQueueConfig(resolve('config/issue-queue.json'));
      const channel = new GitHubIssueChannel({ repository: queueConfig.repository });
      const watcherRepositoryRoot = resolve('.');
      const loadedRevision = await readCheckoutRevision({ repositoryRoot: watcherRepositoryRoot });
      const cloudAction = action === 'cloud-once' || action === 'cloud-peek' || action === 'cloud-admit' || action === 'cloud-recover' || action === 'cloud-repair';
      const requestedLaneId = take('--lane') ?? 'self';
      const cloudLane = cloudAction
        ? queueConfig.cloudLanes.find((lane) => lane.id === requestedLaneId)
        : null;
      if (cloudAction && !cloudLane) throw new Error(`Cloud inbox lane is not configured: ${requestedLaneId}`);
      const activeStore = cloudAction
        ? new GitHubStateStore({
          repository: queueConfig.repository,
          laneId: cloudLane.id,
          allowedProjectIds: cloudLane.projectIds,
          tag: cloudLane.tag,
          statePath: cloudLane.statePath,
          leaseTtlMs: 45 * 60 * 1000
        })
        : store;
      const activeWorkflows = cloudAction
        ? new DurableCloudWorkflowEngine({ store: activeStore, projects })
        : workflows;
      const queue = new SupervisedIssueQueue({
        store: activeStore,
        projects,
        workflowEngine: activeWorkflows,
        channel,
        allowedActors: queueConfig.allowedActors,
        operatorRevision: loadedRevision,
        operatorBranch: 'main',
        includedProjectIds: cloudAction ? cloudLane.projectIds : null,
        excludedProjectIds: cloudAction ? [] : queueConfig.cloudProjectIds
      });
      const autonomousSelfImprovement = cloudAction && cloudLane.id === 'self'
        ? new AutonomousSelfImprovement({ store: activeStore, workflowEngine: activeWorkflows, operatorRevision: loadedRevision })
        : null;
      const view = (record) => record ? {
        issueNumber: record.issueNumber,
        workflowId: record.workflowId,
        status: record.status,
        reason: record.reason,
        pendingApproval: record.pendingApproval ? {
          kind: record.pendingApproval.kind,
          stepId: record.pendingApproval.stepId,
          fingerprint: record.pendingApproval.fingerprint
        } : null,
        publication: record.publication ?? null,
        updatedAt: record.updatedAt
      } : null;
      if (action === 'once') {
        console.log(JSON.stringify(view(await queue.tick()), null, 2));
      } else if (action === 'cloud-admit') {
        const eventName = process.env.GITHUB_EVENT_NAME;
        const eventPath = process.env.GITHUB_EVENT_PATH;
        if (!eventName || !eventPath) throw new Error('cloud-admit requires GITHUB_EVENT_NAME and GITHUB_EVENT_PATH');
        let event;
        try {
          const content = await readBoundedRegularFile(resolve(eventPath), { maxBytes: 256 * 1024, label: 'GitHub event payload' });
          event = JSON.parse(content.toString('utf8'));
        } catch (error) {
          if (/^GitHub event payload (?:must|exceeds|changed)/.test(error.message)) throw error;
          throw new Error(`Invalid GitHub event payload: ${error.message}`, { cause: error });
        }
        console.log(JSON.stringify(await queue.admitEvent(eventName, event), null, 2));
      } else if (action === 'cloud-repair') {
        const snapshot = await activeStore.readSnapshot({ repair: true });
        console.log(JSON.stringify({ generation: snapshot.generation, authorityGeneration: snapshot.authorityGeneration }, null, 2));
      } else if (action === 'cloud-recover') {
        console.log(JSON.stringify(await queue.recoverAdmissionIntents(), null, 2));
      } else if (action === 'cloud-peek') {
        const queueWork = await queue.hasWork();
        const autonomousWork = autonomousSelfImprovement ? await autonomousSelfImprovement.hasWork() : false;
        console.log(String(queueWork || autonomousWork));
      } else if (action === 'cloud-once') {
        const result = await activeStore.withGlobalLease(async () => {
          await queue.ingestAdmissionIntents();
          const queueResult = await queue.tick();
          let autonomousResult = null;
          if (autonomousSelfImprovement && (!queueResult || ['awaiting_start_approval', 'awaiting_workflow_approval'].includes(queueResult.status))) {
            autonomousResult = await autonomousSelfImprovement.tick();
          }
          return { queueResult, autonomousResult };
        });
        console.log(JSON.stringify({
          queue: view(result.queueResult),
          autonomous: result.autonomousResult
        }, null, 2));
      } else if (action === 'watch') {
        const controller = new AbortController();
        const stop = () => controller.abort();
        let checkoutReloadRevision = null;
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        try {
          await watchIssueQueue(queue, {
            pollIntervalMs: queueConfig.pollIntervalMs,
            signal: controller.signal,
            beforeTick: async () => {
              const currentRevision = await readCheckoutRevision({ repositoryRoot: watcherRepositoryRoot });
              if (currentRevision === loadedRevision) return true;
              checkoutReloadRevision = currentRevision;
              controller.abort();
              return false;
            },
            onTick: (record) => {
              if (record) console.log(JSON.stringify(view(record)));
            },
            onError: (error) => {
              console.error(`issue-queue tick failed: ${maskSecrets(error.message)}`);
            }
          });
        } finally {
          process.removeListener('SIGINT', stop);
          process.removeListener('SIGTERM', stop);
        }
        if (checkoutReloadRevision) {
          console.error(`inbox watcher checkout changed; exiting for managed restart (${loadedRevision.slice(0, 12)} -> ${checkoutReloadRevision.slice(0, 12)})`);
        }
      } else throw new Error('Usage: agent inbox <once|cloud-admit [--lane <id>]|cloud-repair [--lane <id>]|cloud-recover [--lane <id>]|cloud-peek [--lane <id>]|cloud-once [--lane <id>]|watch|status>');
    }
  } else if (command === 'service') {
    const action = args[1] ?? 'status';
    if (action === 'install') {
      console.log(JSON.stringify(await installInboxService(), null, 2));
    } else if (action === 'sync') {
      console.log(JSON.stringify(await syncInboxService(), null, 2));
    } else if (action === 'bootstrap') {
      const runtimes = await syncProjectRuntimes([...projects.values()]);
      const service = await syncInboxService();
      const wakeup = await syncWslWakeup();
      console.log(JSON.stringify({ runtimes, service, wakeup }, null, 2));
    } else if (action === 'wakeup') {
      const wakeupAction = args[2] ?? 'status';
      if (wakeupAction === 'sync') console.log(JSON.stringify(await syncWslWakeup(), null, 2));
      else if (wakeupAction === 'status') console.log(JSON.stringify(await wslWakeupStatus(), null, 2));
      else if (wakeupAction === 'uninstall') console.log(JSON.stringify(await uninstallWslWakeup(), null, 2));
      else throw new Error('Usage: agent service wakeup <sync|status|uninstall>');
    } else if (action === 'status') {
      console.log(JSON.stringify(await serviceStatus(), null, 2));
    } else if (action === 'restart') {
      console.log(JSON.stringify(await restartInboxService(), null, 2));
    } else if (action === 'upgrade' || action === 'auto-upgrade') {
      const queueConfig = await loadIssueQueueConfig(resolve('config/issue-queue.json'));
      const upgradeOptions = {
        repositoryRoot: resolve('.'),
        expectedRepository: `${queueConfig.repository.owner}/${queueConfig.repository.name}`,
        stateLoader: () => store.load()
      };
      const result = action === 'auto-upgrade'
        ? await autoUpgradeInboxService(upgradeOptions)
        : await upgradeInboxService(upgradeOptions);
      console.log(JSON.stringify(result, null, 2));
    } else if (action === 'uninstall') {
      console.log(JSON.stringify(await uninstallInboxService(), null, 2));
    } else throw new Error('Usage: agent service <install|sync|bootstrap|wakeup|status|restart|upgrade|auto-upgrade|uninstall>');
  } else if (command === 'workflow') {
    const action = args[1];
    if (action === 'create') {
      const project = projects.get(take('--project'));
      if (!project) throw new Error('Unknown --project');
      const profile = args[2];
      console.log(JSON.stringify(await workflows.create({
        profile,
        projectId: project.id,
        goal: take('--goal') ?? 'Untitled workflow',
        input: await loadWorkflowInput(profile),
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
    } else if (action === 'cancel') {
      console.log(JSON.stringify(await workflows.cancel(args[2], { reason: take('--reason') ?? 'workflow_cancelled_by_operator' }), null, 2));
    } else if (action === 'list') {
      console.log(JSON.stringify(await workflows.list(), null, 2));
    } else throw new Error('Usage: agent workflow create website-build --project <id> --goal "..." --brief business.json [--allowed-path path] [--forbidden-path path] | agent workflow create <app-improvement|data-analysis> --project <id> --goal "..." [--allowed-path path] [--forbidden-path path] | run <id> [--dry-run] | status <id> | resume <id> | approve <id> <step-id> | cancel <id> [--reason reason] | list');
  } else {
    console.log('Usage: agent capabilities --project leadfinder [--surface workflow|orchestrator] | agent specialists --project leadfinder [--surface workflow|orchestrator] | agent doctor --project leadfinder | agent inbox <once|cloud-admit|cloud-repair|cloud-recover|cloud-peek|cloud-once|watch|status> | agent runtime <status|sync> | agent service <install|sync|bootstrap|wakeup|status|restart|upgrade|auto-upgrade|uninstall> | agent run --project leadfinder --goal "..." [--dry-run] [--allowed-path app] [--forbidden-path docs] | agent resume <runId> | agent report <runId> | agent approvals | agent approve <id>');
  }
} catch (error) {
  console.error(maskSecrets(error.stack ?? error.message));
  process.exitCode = 1;
}
