import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkflowEngine, WorkflowStepStatus, maskSecrets, validateWorkflowPlan } from './core.js';

const DURABLE_CHECKPOINT_VERSION = 1;
const governedProfiles = new Set(['app-improvement', 'website-build']);

function exactSha(value) {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

function reviewPassed(step) {
  return step?.evidence?.result?.reviewEvidence?.verdict === 'PASS';
}

function exactPaths(value) {
  return [...new Set((value ?? []).map((path) => String(path)))].sort();
}

export function releaseCheckpointCandidate(plan) {
  if (!plan || !governedProfiles.has(plan.profile) || !Array.isArray(plan.steps)) return null;
  const release = plan.steps.find((step) => step.id === 'release-readiness');
  const implementation = plan.steps.find((step) => step.id === 'implementation');
  const review = plan.steps.find((step) => step.id === 'review');
  if (!release || !implementation || !review) return null;
  if (![WorkflowStepStatus.PENDING, WorkflowStepStatus.AWAITING_APPROVAL].includes(release.status)) return null;
  if (release.evidence?.durableCheckpoint) return null;
  const completed = new Set(plan.steps.filter((step) => step.status === WorkflowStepStatus.COMPLETED).map((step) => step.id));
  if (!release.dependsOn.every((dependency) => completed.has(dependency))) return null;
  const changeSetFingerprint = implementation.evidence?.changeSetFingerprint;
  if (implementation.status !== WorkflowStepStatus.COMPLETED ||
      review.status !== WorkflowStepStatus.COMPLETED ||
      !reviewPassed(review) ||
      !exactSha(changeSetFingerprint) ||
      review.evidence?.reviewedChangeSetFingerprint !== changeSetFingerprint) return null;
  return { release, implementation, review, changeSetFingerprint };
}

export function durableCheckpointExternalWrite() {
  return {
    id: 'release-readiness-durable-checkpoint',
    skill: 'release.publish-reviewed-workflow',
    specialist: 'release-manager',
    purpose: 'Persist the exact reviewed change on the non-protected working branch before the final release-readiness approval.'
  };
}

export function preserveDurableReleaseEvidence(approvedEvidence, durableCheckpoint) {
  if (!durableCheckpoint || !exactSha(durableCheckpoint?.commit?.finalHead)) return approvedEvidence;
  return {
    ...(approvedEvidence ?? {}),
    durableCheckpoint,
    approvedCommitSha: durableCheckpoint.commit.finalHead
  };
}

export class DurableCloudWorkflowEngine extends WorkflowEngine {
  constructor(options = {}) {
    super(options);
    this.preparingDurableCheckpoints = new Set();
    this.suppressDurability = 0;
    this.executionDeadlineContext = new AsyncLocalStorage();
  }

  executionDeadlineCap(id, explicit = null) {
    if (explicit !== null && (!Number.isFinite(explicit) || explicit <= 0)) {
      throw new Error('workflow_deadline_cap_invalid');
    }
    const active = this.executionDeadlineContext?.getStore()?.get(id) ?? null;
    if (explicit === null) return active;
    return active === null ? explicit : Math.min(active, explicit);
  }

  assertExecutionDeadline(id, explicit = null) {
    const cap = this.executionDeadlineCap(id, explicit);
    if (cap !== null && this.now() >= cap) throw new Error('workflow_deadline_cap_exceeded');
    return cap;
  }

  async withExecutionDeadlineCap(id, explicit, task) {
    const cap = this.executionDeadlineCap(id, explicit ?? null);
    if (cap === null) return task();
    this.assertExecutionDeadline(id, cap);
    this.executionDeadlineContext ??= new AsyncLocalStorage();
    const parent = this.executionDeadlineContext.getStore();
    const scoped = new Map(parent ?? []);
    scoped.set(id, cap);
    return this.executionDeadlineContext.run(scoped, task);
  }

  async update(id, mutator) {
    this.assertExecutionDeadline(id);
    const deadlineAt = this.executionDeadlineCap(id);
    return super.update(id, (saved) => {
      this.assertExecutionDeadline(id);
      mutator(saved);
      this.assertExecutionDeadline(id);
    }, {
      beforeCommit: () => this.assertExecutionDeadline(id),
      deadlineAt
    });
  }

  async run(id, options = {}) {
    if (options.dryRun || options.deadlineCapAt === null || options.deadlineCapAt === undefined) {
      return super.run(id, options);
    }
    return this.withExecutionDeadlineCap(id, options.deadlineCapAt, async () => {
      this.assertExecutionDeadline(id);
      return this.store.withExecutionLease(
        'workflows',
        id,
        'workflow',
        async () => super.runUnlocked(id, options),
        {
          beforeClaimCommit: () => this.assertExecutionDeadline(id),
          deadlineAt: this.executionDeadlineCap(id, options.deadlineCapAt)
        }
      );
    });
  }

  async resume(id, options = {}) {
    return this.withExecutionDeadlineCap(id, options.deadlineCapAt ?? null, () => super.resume(id, {
      ...options,
      beforeLeaseClaimCommit: () => this.assertExecutionDeadline(id)
    }));
  }

  async runUnlocked(id, options = {}) {
    if (!options.dryRun) {
      return this.withExecutionDeadlineCap(
        id,
        options.deadlineCapAt ?? null,
        () => super.runUnlocked(id, options)
      );
    }
    this.suppressDurability += 1;
    try {
      const plan = await super.runUnlocked(id, options);
      if (!governedProfiles.has(plan.profile)) return plan;
      const durable = durableCheckpointExternalWrite();
      const existing = Array.isArray(plan.plannedExternalWrites) ? plan.plannedExternalWrites : [];
      if (existing.some((entry) => entry?.id === durable.id)) return plan;
      return { ...plan, plannedExternalWrites: [...existing, durable] };
    } finally {
      this.suppressDurability -= 1;
    }
  }

  async get(id, options = {}) {
    if (options.deadlineCapAt !== null && options.deadlineCapAt !== undefined) {
      return this.withExecutionDeadlineCap(
        id,
        options.deadlineCapAt,
        () => this.get(id)
      );
    }
    const cap = this.assertExecutionDeadline(id);
    const plan = await super.get(id);
    this.assertExecutionDeadline(id, cap);
    if (!plan || this.suppressDurability > 0 || this.preparingDurableCheckpoints.has(id) || !releaseCheckpointCandidate(plan)) return plan;
    validateWorkflowPlan(plan, this.projects, this.registry, this.specialistRegistry);
    this.preparingDurableCheckpoints.add(id);
    try {
      return await this.ensureDurableReleaseCheckpoint(id, { deadlineCapAt: cap });
    } finally {
      this.preparingDurableCheckpoints.delete(id);
    }
  }

  async blockDurability(id, error, detail = null) {
    return this.update(id, (saved) => {
      const release = saved.steps.find((step) => step.id === 'release-readiness');
      if (release && release.status !== WorkflowStepStatus.COMPLETED) {
        release.status = WorkflowStepStatus.BLOCKED;
        release.error = error;
        release.evidence = {
          ...(release.evidence ?? {}),
          type: 'durable-release-checkpoint',
          ok: false,
          error: detail ? maskSecrets(String(detail)).slice(0, 1_000) : null
        };
      }
      saved.status = WorkflowStepStatus.BLOCKED;
      saved.pausedAt = null;
      saved.result = { error, stepId: release?.id ?? 'release-readiness' };
    });
  }

  async remoteWorkingBranch(project, branch) {
    try {
      return await this.publicationBridge.githubForProject(project).branchHead(project, branch);
    } catch (error) {
      if (/GitHub API request failed: 404/i.test(String(error?.message ?? ''))) return null;
      throw error;
    }
  }

  async rehydrateDurableBranch(workspaceProject, plan, checkpoint) {
    const branch = plan.workspace.workingBranch;
    const expectedHead = checkpoint.commit.finalHead;
    if (!exactSha(expectedHead)) throw new Error('durable_checkpoint_commit_sha_invalid');
    await this.localGit.git(
      ['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`],
      workspaceProject,
      { network: true }
    );
    const remoteHead = (await this.localGit.git(['rev-parse', `refs/remotes/origin/${branch}`], workspaceProject)).stdout.trim();
    if (remoteHead !== expectedHead) throw new Error('durable_checkpoint_remote_head_changed');
    await this.localGit.git(['switch', '--create', branch, `refs/remotes/origin/${branch}`], workspaceProject);
    await this.localGit.assertRepositoryState(workspaceProject, {
      branch,
      head: expectedHead,
      remote: plan.workspace.remote
    });
    return workspaceProject;
  }

  async workspaceProject(id, project) {
    const plan = await super.get(id);
    if (!plan?.workspace || existsSync(plan.workspace.path)) return super.workspaceProject(id, project);
    if (!plan.workspace.managed || !plan.workspace.workingBranch || !plan.workspace.baseHead || !plan.workspace.remote) {
      throw new Error('cloud_workspace_rehydration_evidence_missing');
    }
    const expected = this.workspaceManager.describe(project, plan.id);
    if (resolve(expected.workspace) !== resolve(plan.workspace.path)) throw new Error('cloud_workspace_rehydration_path_mismatch');
    const remainingMs = this.remainingMs(plan);
    if (remainingMs <= 0) throw new Error('workflow_budget_deadline_exceeded');
    const allocation = await this.workspaceManager.prepare(project, plan.id, {
      timeoutMs: Math.min(project.budgets.commandTimeoutMs, remainingMs)
    });
    if (resolve(allocation.workspace) !== resolve(plan.workspace.path)) throw new Error('cloud_workspace_rehydration_allocation_mismatch');
    const workspaceProject = { ...project, workspace: resolve(allocation.workspace) };
    const initial = await this.localGit.inspect(workspaceProject);
    if (initial.remote !== plan.workspace.remote) throw new Error('cloud_workspace_rehydration_remote_mismatch');

    const release = plan.steps.find((step) => step.id === 'release-readiness');
    const checkpoint = release?.evidence?.durableCheckpoint ?? null;
    if (checkpoint) return this.rehydrateDurableBranch(workspaceProject, plan, checkpoint);

    const prepared = await this.localGit.prepareWorkingBranch(workspaceProject, plan.id, plan.workspace.baseHead);
    if (prepared.workingBranch !== plan.workspace.workingBranch || prepared.initialHead !== plan.workspace.baseHead || prepared.remote !== plan.workspace.remote) {
      throw new Error('cloud_workspace_rehydration_branch_mismatch');
    }
    return workspaceProject;
  }

  async recoverRemoteCheckpoint(id, project, plan, candidate, remote) {
    const workspaceProject = await this.workspaceProject(id, project);
    const branch = plan.workspace.workingBranch;
    const remoteHead = remote?.head;
    if (!exactSha(remoteHead)) throw new Error('durable_checkpoint_remote_head_invalid');

    const current = await this.localGit.inspectChangeSet(workspaceProject);
    if (current.paths.length) {
      const governed = await this.guardImplementationChangeSet(id, project, candidate.release.id, 'before-durable-remote-recovery');
      if (!governed.ok) return { ok: false, plan: governed.plan };
    }

    await this.localGit.git(
      ['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`],
      workspaceProject,
      { network: true }
    );
    const fetched = (await this.localGit.git(['rev-parse', `refs/remotes/origin/${branch}`], workspaceProject)).stdout.trim();
    if (fetched !== remoteHead) throw new Error('durable_checkpoint_remote_head_raced');
    const ancestry = (await this.localGit.git(['rev-list', '--parents', '-n', '1', remoteHead], workspaceProject)).stdout.trim().split(/\s+/);
    if (ancestry.length !== 2 || ancestry[0] !== remoteHead || ancestry[1] !== plan.workspace.baseHead) {
      throw new Error('durable_checkpoint_remote_parent_mismatch');
    }
    await this.localGit.git(['reset', '--hard', remoteHead], workspaceProject);
    await this.localGit.git(['reset', '--mixed', plan.workspace.baseHead], workspaceProject);
    const recoveredChangeSet = await this.localGit.inspectChangeSet(workspaceProject);
    const expectedPaths = exactPaths(candidate.implementation.evidence?.changeSet?.paths);
    if (recoveredChangeSet.changeSetFingerprint !== candidate.changeSetFingerprint ||
        JSON.stringify(exactPaths(recoveredChangeSet.paths)) !== JSON.stringify(expectedPaths)) {
      await this.localGit.git(['reset', '--hard', remoteHead], workspaceProject);
      throw new Error('durable_checkpoint_remote_change_set_mismatch');
    }
    await this.localGit.git(['reset', '--hard', remoteHead], workspaceProject);
    await this.localGit.assertRepositoryState(workspaceProject, {
      branch,
      head: remoteHead,
      remote: plan.workspace.remote
    });
    return {
      ok: true,
      commit: {
        finalHead: remoteHead,
        committedPaths: expectedPaths,
        committedChangeSetFingerprint: candidate.changeSetFingerprint,
        recovered: true
      },
      push: {
        branch,
        finalHead: remoteHead,
        remoteBranchHead: remoteHead,
        recovered: true
      }
    };
  }

  async ensureDurableReleaseCheckpoint(id, { deadlineCapAt = null } = {}) {
    const guard = () => this.assertExecutionDeadline(id, deadlineCapAt);
    guard();
    let plan = await super.get(id);
    guard();
    const candidate = releaseCheckpointCandidate(plan);
    if (!candidate) return plan;
    const project = this.projects.get(plan.projectId);
    if (!project || !plan.workspace?.managed || !plan.workspace.workingBranch || !plan.workspace.baseHead || !plan.workspace.remote) {
      return this.blockDurability(id, 'durable_checkpoint_workspace_invalid');
    }
    const publicationCapability = this.registry.resolve(project, 'release.publish-reviewed-workflow', { surface: 'workflow' });
    if (!publicationCapability.available) {
      return this.blockDurability(id, 'durable_checkpoint_publication_capability_unavailable', publicationCapability.reason);
    }

    let base;
    try {
      guard();
      base = await this.publicationBridge.inspectBase(project);
      guard();
    } catch (error) {
      return this.blockDurability(id, 'durable_checkpoint_base_observation_failed', error.message);
    }
    const expectedRepository = `${project.repository.owner}/${project.repository.name}`;
    if (base.repository !== expectedRepository || base.defaultBranch !== project.defaultBranch || base.head !== plan.workspace.baseHead) {
      return this.blockDurability(id, 'durable_checkpoint_base_head_changed');
    }

    let remote;
    try {
      guard();
      remote = await this.remoteWorkingBranch(project, plan.workspace.workingBranch);
      guard();
    } catch (error) {
      return this.blockDurability(id, 'durable_checkpoint_remote_observation_failed', error.message);
    }

    let commit;
    let push;
    if (remote) {
      try {
        guard();
        const recovered = await this.recoverRemoteCheckpoint(id, project, plan, candidate, remote);
        guard();
        if (!recovered.ok) return recovered.plan;
        ({ commit, push } = recovered);
      } catch (error) {
        return this.blockDurability(id, 'durable_checkpoint_remote_recovery_failed', error.message);
      }
    } else {
      guard();
      const governed = await this.guardImplementationChangeSet(id, project, candidate.release.id, 'before-durable-checkpoint');
      guard();
      if (!governed.ok) return governed.plan;
      const workspaceProject = await this.workspaceProject(id, project);
      guard();
      try {
        guard();
        commit = await this.publicationBridge.commit(workspaceProject, {
          workflowId: plan.id,
          goal: `durable checkpoint ${plan.goal}`,
          branch: plan.workspace.workingBranch,
          baseHead: plan.workspace.baseHead,
          remote: plan.workspace.remote,
          changeSetFingerprint: candidate.changeSetFingerprint,
          deadlineAt: this.executionDeadlineCap(id, deadlineCapAt)
        });
        guard();
        const expectedPaths = exactPaths(candidate.implementation.evidence?.changeSet?.paths);
        if (!exactSha(commit?.finalHead) ||
            commit.committedChangeSetFingerprint !== candidate.changeSetFingerprint ||
            JSON.stringify(exactPaths(commit.committedPaths)) !== JSON.stringify(expectedPaths)) {
          throw new Error('durable_checkpoint_commit_mismatch');
        }
        try {
          guard();
          push = await this.publicationBridge.push(workspaceProject, {
            branch: plan.workspace.workingBranch,
            commitHead: commit.finalHead,
            remote: plan.workspace.remote,
            deadlineAt: this.executionDeadlineCap(id, deadlineCapAt)
          });
        } catch (error) {
          guard();
          const uncertain = await this.remoteWorkingBranch(project, plan.workspace.workingBranch);
          guard();
          if (!uncertain || uncertain.head !== commit.finalHead) throw error;
          push = { branch: plan.workspace.workingBranch, finalHead: commit.finalHead, recoveredAfterUncertainPush: true };
        }
        guard();
        const verified = await this.publicationBridge.verifyRemoteBranch(project, plan.workspace.workingBranch, commit.finalHead);
        guard();
        if (!verified.ok || push.finalHead !== commit.finalHead) throw new Error('durable_checkpoint_push_mismatch');
        push = { ...push, remoteBranchHead: verified.head };
      } catch (error) {
        return this.blockDurability(id, 'durable_checkpoint_publication_failed', error.message);
      }
    }

    guard();
    const checkpoint = {
      version: DURABLE_CHECKPOINT_VERSION,
      changeSetFingerprint: candidate.changeSetFingerprint,
      branch: plan.workspace.workingBranch,
      baseHead: plan.workspace.baseHead,
      baseObservation: base,
      commit,
      push
    };
    return this.update(id, (saved) => {
      const release = saved.steps.find((step) => step.id === 'release-readiness');
      if (![WorkflowStepStatus.PENDING, WorkflowStepStatus.AWAITING_APPROVAL].includes(release?.status)) {
        throw new Error('durable_checkpoint_release_state_changed');
      }
      release.evidence = {
        ...(release.evidence ?? {}),
        type: 'durable-release-checkpoint',
        ok: true,
        durableCheckpoint: checkpoint
      };
    });
  }

  async approveUnlocked(id, stepId, options = {}) {
    const before = await this.get(id);
    const durableCheckpoint = stepId === 'release-readiness'
      ? before?.steps?.find((step) => step.id === stepId)?.evidence?.durableCheckpoint ?? null
      : null;
    const approved = await super.approveUnlocked(id, stepId, options);
    if (!durableCheckpoint) return approved;
    return this.update(id, (saved) => {
      const step = saved.steps.find((candidate) => candidate.id === stepId);
      if (step?.status !== WorkflowStepStatus.COMPLETED) throw new Error('durable_checkpoint_approval_state_invalid');
      step.evidence = preserveDurableReleaseEvidence(step.evidence, durableCheckpoint);
    });
  }

  async existingPullRequest(project, branch, commitHead) {
    const github = this.publicationBridge.githubForProject(project);
    const query = new URLSearchParams({
      state: 'open',
      head: `${project.repository.owner}:${branch}`,
      base: project.defaultBranch,
      per_page: '100'
    });
    const pullRequests = await github.request(github.path(project, `/pulls?${query}`));
    if (!Array.isArray(pullRequests)) throw new Error('durable_checkpoint_pull_request_list_invalid');
    const matches = pullRequests.filter((pullRequest) =>
      pullRequest?.head?.sha === commitHead &&
      pullRequest?.head?.ref === branch &&
      pullRequest?.base?.ref === project.defaultBranch
    );
    if (matches.length > 1) throw new Error('durable_checkpoint_multiple_pull_requests');
    if (!matches.length) return null;
    return { number: matches[0].number, url: matches[0].html_url, state: matches[0].state };
  }

  async executePublicationWorkflowStep(id, project, next) {
    let plan = await super.get(id);
    const release = plan.steps.find((step) => step.id === 'release-readiness');
    const implementation = plan.steps.find((step) => step.id === 'implementation');
    const review = plan.steps.find((step) => step.id === 'review');
    const checkpoint = release?.evidence?.durableCheckpoint ?? null;
    const expectedFingerprint = implementation?.evidence?.changeSetFingerprint ?? null;
    if (!checkpoint ||
        implementation?.status !== WorkflowStepStatus.COMPLETED ||
        review?.status !== WorkflowStepStatus.COMPLETED ||
        release?.status !== WorkflowStepStatus.COMPLETED ||
        !reviewPassed(review) ||
        checkpoint.version !== DURABLE_CHECKPOINT_VERSION ||
        checkpoint.changeSetFingerprint !== expectedFingerprint ||
        release.evidence?.approvedCommitSha !== checkpoint.commit?.finalHead ||
        release.evidence?.approvedChangeSetFingerprint !== expectedFingerprint ||
        review.evidence?.reviewedChangeSetFingerprint !== expectedFingerprint ||
        !exactSha(checkpoint.commit?.finalHead) ||
        !plan.workspace?.managed ||
        plan.workspace.workingBranch !== checkpoint.branch ||
        plan.workspace.baseHead !== checkpoint.baseHead) {
      return this.stopPublication(id, next.id, 'workflow_publication_durable_checkpoint_invalid', { blocked: false, phase: 'preflight' });
    }
    if (next.attempts >= plan.budgets.maxAttempts) {
      return this.stopPublication(id, next.id, 'workflow_publication_attempt_budget_exhausted', { blocked: false, phase: next.evidence?.phase ?? 'preflight' });
    }

    if (!next.evidence?.commit) {
      let base;
      let remote;
      try {
        base = await this.publicationBridge.inspectBase(project);
        remote = await this.publicationBridge.verifyRemoteBranch(project, checkpoint.branch, checkpoint.commit.finalHead);
      } catch (error) {
        return this.stopPublication(id, next.id, 'workflow_publication_durable_checkpoint_revalidation_failed', {
          blocked: false,
          phase: 'preflight',
          patch: { error: maskSecrets(error.message).slice(0, 1_000) }
        });
      }
      if (base.head !== checkpoint.baseHead || base.defaultBranch !== project.defaultBranch || !remote.ok) {
        return this.stopPublication(id, next.id, 'workflow_publication_durable_checkpoint_changed', { blocked: false, phase: 'preflight' });
      }

      let created;
      let observed;
      try {
        created = await this.existingPullRequest(project, checkpoint.branch, checkpoint.commit.finalHead);
        if (!created) {
          created = await this.publicationBridge.createPullRequest(project, {
            workflowId: plan.id,
            goal: plan.goal,
            branch: checkpoint.branch,
            commitHead: checkpoint.commit.finalHead,
            changeSetFingerprint: expectedFingerprint
          });
        }
        observed = await this.publicationBridge.verifyPullRequest(project, created.number, {
          branch: checkpoint.branch,
          commitHead: checkpoint.commit.finalHead
        });
      } catch (error) {
        return this.stopPublication(id, next.id, 'workflow_publication_pr_state_uncertain', {
          phase: 'pr-uncertain',
          patch: { error: maskSecrets(error.message).slice(0, 1_000) }
        });
      }
      if (!observed.ok) return this.stopPublication(id, next.id, 'workflow_publication_pr_mismatch', { blocked: false, phase: 'pr-invalid' });
      const pullRequest = {
        number: observed.number,
        url: observed.url,
        state: observed.state,
        headSha: observed.headSha,
        headRef: observed.headRef,
        baseRef: observed.baseRef
      };
      await this.update(id, (saved) => {
        const step = saved.steps.find((candidate) => candidate.id === next.id);
        step.evidence = {
          type: 'executor',
          ok: false,
          phase: 'pr-created',
          workspacePath: saved.workspace.path,
          branch: checkpoint.branch,
          baseHead: checkpoint.baseHead,
          remote: saved.workspace.remote,
          reviewedChangeSetFingerprint: expectedFingerprint,
          approvedChangeSetFingerprint: expectedFingerprint,
          baseObservation: base,
          commit: checkpoint.commit,
          push: checkpoint.push,
          pullRequest
        };
      });
      plan = await super.get(id);
      next = plan.steps.find((step) => step.id === next.id);
    }

    return super.executePublicationWorkflowStep(id, project, next);
  }
}
