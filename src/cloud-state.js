import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { JsonStore } from './core.js';

const DEFAULT_TAG = 'agent-cloud-state-v1';
const DEFAULT_PATH = '.agent/cloud-state.json';
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_LEASE_TTL_MS = 20 * 60 * 1000;
const GITHUB_READ_RATE_LIMIT_RETRY_DELAYS_MS = Object.freeze([60_000, 120_000]);
const GITHUB_READ_RATE_LIMIT_MAX_DELAY_MS = 12 * 60 * 1000;
const STATUS_PAGE_SIZE = 100;
const EPOCH_STATUS_MAX_PAGES = 8;
const EPOCH_SIZE = 256;
const CHECKPOINT_NAMESPACE = 'agent-cloud-state-v2-checkpoints';
const WITNESS_NAMESPACE = 'agent-cloud-state-v2-witnesses';
const CLAIM_NAMESPACE = 'agent-cloud-state-v2-claims';
const EPOCH_ANCHOR_NAMESPACE = 'agent-cloud-state-v2-epoch-anchors';
const LANE_ROOT_AUTHOR_NAME = 'Cloud State v2';
const LANE_ROOT_AUTHOR_EMAIL = 'cloud-state-v2@users.noreply.github.com';
const LANE_ROOT_AUTHOR_DATE = '2000-01-01T00:00:00Z';
const LANE_ROOT_AUTHOR_TIMESTAMP = 946684800;
const LEDGER_ROOT_SHA = 'b4f3b2e76e24be58d241227850a5d48ea19c2ea8';
const LEDGER_CONTEXT_ROOT = 'agent-cloud-state-v2';
const RESERVED_STATE_TAGS = new Set([
  CHECKPOINT_NAMESPACE,
  WITNESS_NAMESPACE,
  CLAIM_NAMESPACE,
  EPOCH_ANCHOR_NAMESPACE
]);



function sensitiveKey(key) {
  const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return /(^|_)(api_key|api_token|access_token|refresh_token|auth_token|github_token|vercel_token|secret|password|credential|authorization|cookie)($|_)/.test(normalized);
}

function containsKnownSecret(value) {
  return /\b(?:gh[pousr]_[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|vcp_[A-Za-z0-9_-]+)\b/i.test(value) ||
    /\bAuthorization\s*:\s*(?:Basic|Bearer)\s+[^\s,;}"'\]]+/i.test(value);
}

function emptyState() {
  return { runs: {}, approvals: {}, events: [] };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function stateHash(state) {
  return createHash('sha256').update(JSON.stringify(canonical(state))).digest('hex');
}

function epochForGeneration(generation) {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('cloud_state_generation_invalid');
  return Math.floor((generation - 1) / EPOCH_SIZE);
}

function epochEndGeneration(epoch) {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('cloud_state_epoch_invalid');
  return (epoch + 1) * EPOCH_SIZE;
}

function assertSha(value, code = 'cloud_state_sha_invalid') {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value)) throw new Error(code);
  return value.toLowerCase();
}

function checkpointTagFor(tag) {
  return `${CHECKPOINT_NAMESPACE}/${tag}`;
}

function witnessTagFor(tag) {
  return `${WITNESS_NAMESPACE}/${tag}`;
}

function assertNoSensitiveKeys(value, path = 'state') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveKeys(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKey(key) && child !== null && child !== undefined && child !== '') {
      throw new Error(`cloud_state_sensitive_key:${path}.${key}`);
    }
    assertNoSensitiveKeys(child, `${path}.${key}`);
  }
}

function sanitizeRemoteOnlyEvidence(value) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(sanitizeRemoteOnlyEvidence);
    return;
  }
  if (value.workerEvidence && typeof value.workerEvidence === 'object') {
    delete value.workerEvidence.output;
    delete value.workerEvidence.diagnostics;
  }
  for (const child of Object.values(value)) sanitizeRemoteOnlyEvidence(child);
}

function normalizeAllowedProjectIds(value = ['self']) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new Error('cloud_state_allowed_projects_invalid');
  const normalized = [...new Set(value.map((projectId) => String(projectId ?? '').trim()))].sort();
  if (normalized.length < 1 || normalized.some((projectId) => !/^[a-z0-9-]{1,80}$/.test(projectId))) {
    throw new Error('cloud_state_allowed_projects_invalid');
  }
  return normalized;
}

function assertProjectOwnership(state, allowedProjectIds) {
  const allowed = new Set(allowedProjectIds);
  const check = (projectId) => {
    if (projectId && !allowed.has(projectId)) throw new Error('cloud_state_project_ownership_mismatch');
  };
  for (const run of Object.values(state.runs ?? {})) check(run?.projectId);
  for (const workflow of Object.values(state.workflows ?? {})) check(workflow?.projectId);
  for (const record of Object.values(state.requests ?? {})) check(record?.request?.projectId ?? record?.projectId ?? null);
}

export function validateCloudState(state, { maxBytes = DEFAULT_MAX_BYTES, allowedProjectIds = ['self'] } = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('cloud_state_invalid');
  const normalizedAllowedProjectIds = normalizeAllowedProjectIds(allowedProjectIds);
  assertProjectOwnership(state, normalizedAllowedProjectIds);
  assertNoSensitiveKeys(state);
  const serialized = JSON.stringify(state);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new Error('cloud_state_too_large');
  if (containsKnownSecret(serialized)) throw new Error('cloud_state_contains_secret_material');
  return state;
}

async function githubReadRateLimitDelayMs(response, fallbackDelayMs, nowMs) {
  if (![403, 429].includes(response?.status)) return null;
  const header = (name) => response?.headers?.get?.(name) ?? null;
  const retryAfter = header('retry-after');
  if (/^\d+$/.test(String(retryAfter ?? ''))) {
    return Math.min(GITHUB_READ_RATE_LIMIT_MAX_DELAY_MS, Math.max(1_000, Number(retryAfter) * 1_000));
  }
  const remaining = header('x-ratelimit-remaining');
  const reset = header('x-ratelimit-reset');
  if (remaining === '0' && /^\d+$/.test(String(reset ?? '')) && Number.isFinite(nowMs)) {
    const resetDelayMs = (Number(reset) * 1_000) - nowMs + 1_000;
    if (resetDelayMs > 0) return Math.min(GITHUB_READ_RATE_LIMIT_MAX_DELAY_MS, resetDelayMs);
  }
  let body = '';
  try {
    const readable = typeof response?.clone === 'function' ? response.clone() : response;
    if (typeof readable?.text === 'function') body = await readable.text();
  } catch {
    body = '';
  }
  const rateLimited = response.status === 429 || remaining === '0' || /secondary rate limit|rate limit exceeded|abuse detection/i.test(body);
  return rateLimited ? fallbackDelayMs : null;
}

function responseError(status) {
  if ([409, 422].includes(status)) return new Error('cloud_state_conflict');
  return new Error(`cloud_state_github_request_failed:${status}`);
}

export class GitHubStateStore extends JsonStore {
  constructor({
    repository,
    token = process.env.GITHUB_TOKEN,
    fetchImpl = fetch,
    tag = DEFAULT_TAG,
    statePath = DEFAULT_PATH,
    laneId = 'self',
    allowedProjectIds = ['self'],
    baseBranch = 'main',
    maxBytes = DEFAULT_MAX_BYTES,
    leaseTtlMs = DEFAULT_LEASE_TTL_MS,
    ownerId = process.env.GITHUB_RUN_ID
      ? `github:${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`
      : `cloud:${randomUUID()}`,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  } = {}) {
    super('.agent/cloud-state-unused.json');
    if (!repository?.owner || !repository?.name) throw new Error('cloud_state_repository_required');
    if (!/^[A-Za-z0-9._/-]+$/.test(baseBranch) || baseBranch.includes('..')) throw new Error('cloud_state_base_branch_invalid');
    if (!token) throw new Error('cloud_state_github_token_required');
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(tag)) throw new Error('cloud_state_tag_invalid');
    if (RESERVED_STATE_TAGS.has(tag)) throw new Error('cloud_state_tag_reserved');
    if (!/^[a-z0-9-]{1,80}$/.test(laneId)) throw new Error('cloud_state_lane_invalid');
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(statePath) || statePath.includes('..')) throw new Error('cloud_state_path_invalid');
    const normalizedAllowedProjectIds = normalizeAllowedProjectIds(allowedProjectIds);
    if (!Number.isInteger(maxBytes) || maxBytes < 16 * 1024 || maxBytes > 2 * 1024 * 1024) throw new Error('cloud_state_max_bytes_invalid');
    if (!Number.isInteger(leaseTtlMs) || leaseTtlMs < 60_000 || leaseTtlMs > 60 * 60 * 1000) throw new Error('cloud_state_lease_ttl_invalid');
    if (typeof sleep !== 'function') throw new Error('cloud_state_sleep_invalid');
    this.repository = repository;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.tag = tag;
    this.checkpointTag = checkpointTagFor(tag);
    this.witnessTag = witnessTagFor(tag);
    this.statePath = statePath;
    this.laneId = laneId;
    this.allowedProjectIds = normalizedAllowedProjectIds;
    this.baseBranch = baseBranch;
    this.maxBytes = maxBytes;
    this.leaseTtlMs = leaseTtlMs;
    this.ownerId = ownerId;
    this.now = now;
    this.sleep = sleep;
    this.activeGlobalLeaseId = null;
    this.mutationDeadlineContext = new AsyncLocalStorage();
    this.validatedLineageHeads = new Set();
    this.ledgerRootVerified = false;
    this.ledgerFullDigest = createHash('sha256').update(JSON.stringify(canonical({
      repository: `${repository.owner}/${repository.name}`,
      laneId,
      statePath,
      stateTag: tag,
      checkpointTag: this.checkpointTag,
      witnessTag: this.witnessTag
    }))).digest('hex');
    this.ledgerDigest = this.ledgerFullDigest.slice(0, 32);
    this.epochAnchorPrefix = `${EPOCH_ANCHOR_NAMESPACE}/${this.ledgerDigest}/`;
    this.laneInitContextName = `${LEDGER_CONTEXT_ROOT}/${this.ledgerDigest}/init`;
    this.laneRootContextName = `${LEDGER_CONTEXT_ROOT}/${this.ledgerDigest}/first`;
    this.epochRegistrationContextName = `${LEDGER_CONTEXT_ROOT}/${this.ledgerDigest}/epoch`;
    this.epochSealContextName = `${LEDGER_CONTEXT_ROOT}/${this.ledgerDigest}/seal`;
    this.epochNextContextName = `${LEDGER_CONTEXT_ROOT}/${this.ledgerDigest}/next`;
    this.epochAuthorityPrefix = `${LEDGER_CONTEXT_ROOT}/${this.ledgerDigest}/g/`;
    this.claimPrefix = `${CLAIM_NAMESPACE}/${this.ledgerDigest}/`;
    this.ledgerRootTreeSha = null;
  }

  apiPath(suffix) {
    return `https://api.github.com/repos/${encodeURIComponent(this.repository.owner)}/${encodeURIComponent(this.repository.name)}${suffix}`;
  }

  async request(suffix, { method = 'GET', body, allow404 = false } = {}) {
    const deadlineAt = method === 'GET' ? null : this.mutationDeadlineContext?.getStore() ?? null;
    let timeoutMs = 30_000;
    if (deadlineAt !== null) {
      if (!Number.isFinite(deadlineAt) || deadlineAt <= 0) throw new Error('cloud_state_deadline_invalid');
      const remainingMs = Math.floor(deadlineAt - this.now());
      if (remainingMs <= 0) throw new Error('workflow_deadline_cap_exceeded');
      timeoutMs = Math.min(timeoutMs, remainingMs);
    }
    const retryDelays = method === 'GET' ? GITHUB_READ_RATE_LIMIT_RETRY_DELAYS_MS : [];
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await this.fetchImpl(this.apiPath(suffix), {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json'
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: globalThis.AbortSignal.timeout(timeoutMs)
        });
      } catch (error) {
        throw new Error('cloud_state_github_request_failed', { cause: error });
      }
      if (allow404 && response.status === 404) return null;
      if (response.ok) return response.status === 204 ? null : response.json();

      const fallbackDelayMs = retryDelays[attempt];
      if (fallbackDelayMs !== undefined) {
        const delayMs = await githubReadRateLimitDelayMs(response, fallbackDelayMs, this.now());
        if (delayMs !== null) {
          await this.sleep(delayMs);
          continue;
        }
      }
      throw responseError(response.status);
    }
  }


  async refSha(ref) {
    const result = await this.request(`/git/ref/${ref}`, { allow404: true });
    if (!result) return null;
    return assertSha(result?.object?.sha, 'cloud_state_ref_invalid');
  }

  async readRefs() {
    const [stateSha, checkpointSha, witnessSha] = await Promise.all([
      this.refSha(`tags/${encodeURIComponent(this.tag)}`),
      this.refSha(`tags/${encodeURIComponent(this.checkpointTag)}`),
      this.refSha(`tags/${encodeURIComponent(this.witnessTag)}`)
    ]);
    return { stateSha, checkpointSha, witnessSha };
  }

  async readCommit(sha) {
    const normalized = assertSha(sha);
    const commit = await this.request(`/git/commits/${normalized}`);
    if (assertSha(commit?.sha, 'cloud_state_commit_invalid') !== normalized) throw new Error('cloud_state_commit_invalid');
    if (!Array.isArray(commit.parents)) throw new Error('cloud_state_commit_invalid');
    return commit;
  }

  async compareCommits(baseSha, headSha) {
    const base = assertSha(baseSha);
    const head = assertSha(headSha);
    if (base === head) return 'identical';
    const comparison = await this.request(`/compare/${base}...${head}`);
    if (!['ahead', 'behind', 'diverged', 'identical'].includes(comparison?.status)) throw new Error('cloud_state_compare_invalid');
    return comparison.status;
  }

  async readStatusContext(commitSha, contextName) {
    const oid = assertSha(commitSha);
    if (typeof contextName !== 'string' || contextName.length < 1 || contextName.length > 200) {
      throw new Error('cloud_state_status_context_invalid');
    }
    const query = `query CloudStateContext($owner: String!, $name: String!, $oid: GitObjectID!, $context: String!) {
      repository(owner: $owner, name: $name) {
        object(oid: $oid) {
          ... on Commit {
            status {
              context(name: $context) {
                context
                state
                description
                targetUrl
              }
            }
          }
        }
      }
    }`;
    const variables = {
      owner: this.repository.owner,
      name: this.repository.name,
      oid,
      context: contextName
    };

    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await this.fetchImpl('https://api.github.com/graphql', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ query, variables }),
          signal: globalThis.AbortSignal.timeout(30_000)
        });
      } catch (error) {
        throw new Error('cloud_state_github_request_failed', { cause: error });
      }

      if (response.ok) {
        const payload = await response.json();
        if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
          throw new Error('cloud_state_graphql_invalid');
        }
        const object = payload?.data?.repository?.object;
        if (!object || !('status' in object)) throw new Error('cloud_state_graphql_invalid');
        const status = object.status?.context ?? null;
        if (!status) return null;
        return {
          context: status.context,
          state: String(status.state ?? '').toLowerCase(),
          description: status.description ?? null,
          target_url: status.targetUrl ?? null
        };
      }

      const fallbackDelayMs = GITHUB_READ_RATE_LIMIT_RETRY_DELAYS_MS[attempt];
      if (fallbackDelayMs !== undefined) {
        const delayMs = await githubReadRateLimitDelayMs(response, fallbackDelayMs, this.now());
        if (delayMs !== null) {
          await this.sleep(delayMs);
          continue;
        }
      }
      throw responseError(response.status);
    }
  }

  validateEnvelope(envelope) {
    if (![1, 2].includes(envelope?.version) ||
        envelope.repository !== `${this.repository.owner}/${this.repository.name}` ||
        !Number.isInteger(envelope.generation) ||
        envelope.generation < 1 ||
        !/^[a-f0-9]{64}$/.test(envelope.stateHash ?? '')) {
      throw new Error('cloud_state_envelope_invalid');
    }
    const persistedLaneId = envelope.laneId ?? 'self';
    if (persistedLaneId !== this.laneId) throw new Error('cloud_state_lane_mismatch');
    if (envelope.version === 2 && (
      envelope.statePath !== this.statePath ||
      envelope.stateTag !== this.tag ||
      envelope.checkpointTag !== this.checkpointTag ||
      envelope.witnessTag !== this.witnessTag
    )) {
      throw new Error('cloud_state_ref_binding_mismatch');
    }
    if (envelope.version === 2 && (
      !/^[a-f0-9]{40}$/i.test(envelope.lineageBaseSha ?? '') ||
      !Number.isInteger(envelope.lineageBaseGeneration) ||
      envelope.lineageBaseGeneration < 0 ||
      envelope.lineageBaseGeneration >= envelope.generation
    )) {
      throw new Error('cloud_state_lineage_anchor_invalid');
    }
    validateCloudState(envelope.state, { maxBytes: this.maxBytes, allowedProjectIds: this.allowedProjectIds });
    if (stateHash(envelope.state) !== envelope.stateHash) throw new Error('cloud_state_integrity_mismatch');
    return envelope;
  }

  parseHistoryBlob(blob) {
    if (!blob || typeof blob !== 'object' ||
        !Number.isInteger(blob.byteSize) || blob.byteSize < 0 || blob.byteSize > this.maxBytes * 2 ||
        blob.isBinary !== false || blob.isTruncated !== false || typeof blob.text !== 'string') {
      throw new Error('cloud_state_history_blob_invalid');
    }
    if (Buffer.byteLength(blob.text, 'utf8') !== blob.byteSize) throw new Error('cloud_state_history_blob_invalid');
    let envelope;
    try { envelope = JSON.parse(blob.text); } catch { throw new Error('cloud_state_envelope_invalid'); }
    return this.validateEnvelope(envelope);
  }

  async readEnvelopeAt(commitSha) {
    const sha = assertSha(commitSha);
    const encodedPath = this.statePath.split('/').map(encodeURIComponent).join('/');
    const file = await this.request(`/contents/${encodedPath}?ref=${encodeURIComponent(sha)}`, { allow404: true });
    if (file?.type !== 'file' || file?.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('cloud_state_file_invalid');
    const raw = Buffer.from(file.content.replace(/\s+/g, ''), 'base64').toString('utf8');
    if (Buffer.byteLength(raw, 'utf8') > this.maxBytes * 2) throw new Error('cloud_state_envelope_too_large');
    let envelope;
    try { envelope = JSON.parse(raw); } catch { throw new Error('cloud_state_envelope_invalid'); }
    return this.validateEnvelope(envelope);
  }

  async baseBranchSha() {
    const sha = await this.refSha(`heads/${encodeURIComponent(this.baseBranch)}`);
    if (!sha) throw new Error('cloud_state_base_branch_missing');
    return sha;
  }

  async verifyLedgerRoot() {
    if (this.ledgerRootVerified) return;
    const root = await this.readCommit(LEDGER_ROOT_SHA);
    if (root.parents.length !== 0) throw new Error('cloud_state_status_root_invalid');
    this.ledgerRootTreeSha = assertSha(root?.tree?.sha, 'cloud_state_status_root_invalid');
    this.ledgerRootVerified = true;
  }

  laneRootCommitSpec() {
    if (!this.ledgerRootVerified || !this.ledgerRootTreeSha) throw new Error('cloud_state_status_root_invalid');
    const message = `Cloud State v2 lane root ${this.ledgerFullDigest}`;
    const authorLine = `${LANE_ROOT_AUTHOR_NAME} <${LANE_ROOT_AUTHOR_EMAIL}> ${LANE_ROOT_AUTHOR_TIMESTAMP} +0000`;
    const body = `tree ${this.ledgerRootTreeSha}\nauthor ${authorLine}\ncommitter ${authorLine}\n\n${message}`;
    const sha = createHash('sha1')
      .update(`commit ${Buffer.byteLength(body, "utf8")}\0${body}`)
      .digest('hex');
    return {
      sha,
      message,
      tree: this.ledgerRootTreeSha,
      parents: [],
      author: {
        name: LANE_ROOT_AUTHOR_NAME,
        email: LANE_ROOT_AUTHOR_EMAIL,
        date: LANE_ROOT_AUTHOR_DATE
      },
      committer: {
        name: LANE_ROOT_AUTHOR_NAME,
        email: LANE_ROOT_AUTHOR_EMAIL,
        date: LANE_ROOT_AUTHOR_DATE
      }
    };
  }

  validateLaneRootCommit(commit, spec) {
    if (!commit || assertSha(commit.sha, 'cloud_state_lane_root_invalid') !== spec.sha ||
        assertSha(commit?.tree?.sha, 'cloud_state_lane_root_invalid') !== spec.tree ||
        !Array.isArray(commit.parents) || commit.parents.length !== 0 ||
        commit.message !== spec.message ||
        commit.author?.name !== LANE_ROOT_AUTHOR_NAME ||
        commit.author?.email !== LANE_ROOT_AUTHOR_EMAIL ||
        commit.author?.date !== LANE_ROOT_AUTHOR_DATE ||
        commit.committer?.name !== LANE_ROOT_AUTHOR_NAME ||
        commit.committer?.email !== LANE_ROOT_AUTHOR_EMAIL ||
        commit.committer?.date !== LANE_ROOT_AUTHOR_DATE) {
      throw new Error('cloud_state_lane_root_invalid');
    }
  }

  laneInitDescription(laneRootSha) {
    return `r=${assertSha(laneRootSha)}`;
  }

  async readLaneInitMarker() {
    await this.verifyLedgerRoot();
    const status = await this.readStatusContext(LEDGER_ROOT_SHA, this.laneInitContextName);
    if (!status) return null;
    if (status.context.toLowerCase() !== this.laneInitContextName.toLowerCase() ||
        status.state !== 'success' ||
        (status.target_url !== null && status.target_url !== undefined) ||
        typeof status.description !== 'string') {
      throw new Error('cloud_state_lane_init_invalid');
    }
    const match = /^r=([a-f0-9]{40})$/i.exec(status.description);
    if (!match) throw new Error('cloud_state_lane_init_invalid');
    return { laneRootSha: assertSha(match[1], 'cloud_state_lane_init_invalid') };
  }

  async ensureLaneInitMarker(laneRootSha) {
    const expected = assertSha(laneRootSha);
    const before = await this.readLaneInitMarker();
    if (before) {
      if (before.laneRootSha === expected) return;
      throw new Error('cloud_state_lane_init_conflict');
    }
    let postError = null;
    try {
      await this.request(`/statuses/${LEDGER_ROOT_SHA}`, {
        method: 'POST',
        body: {
          state: 'success',
          context: this.laneInitContextName,
          description: this.laneInitDescription(expected)
        }
      });
    } catch (error) {
      postError = error;
    }
    const after = await this.readLaneInitMarker();
    if (after?.laneRootSha === expected) return;
    if (after) throw new Error('cloud_state_lane_init_conflict', { cause: postError ?? undefined });
    if (postError) throw postError;
    throw new Error('cloud_state_lane_init_append_failed');
  }

  async laneRootCommit({ create = false } = {}) {
    await this.verifyLedgerRoot();
    const spec = this.laneRootCommitSpec();
    const marker = await this.readLaneInitMarker();

    if (marker && marker.laneRootSha !== spec.sha) throw new Error('cloud_state_lane_init_conflict');
    if (!marker && !create) return null;

    let commit = await this.request(`/git/commits/${spec.sha}`, { allow404: true });
    if (!commit && create) {
      const created = await this.request('/git/commits', {
        method: 'POST',
        body: {
          message: spec.message,
          tree: spec.tree,
          parents: [],
          author: spec.author,
          committer: spec.committer
        }
      });
      if (assertSha(created?.sha, 'cloud_state_lane_root_invalid') !== spec.sha) {
        throw new Error('cloud_state_lane_root_invalid');
      }
      commit = await this.request(`/git/commits/${spec.sha}`);
    }
    if (!commit) throw new Error('cloud_state_lane_root_missing');
    this.validateLaneRootCommit(commit, spec);

    if (!marker) await this.ensureLaneInitMarker(spec.sha);
    return spec;
  }

  laneRootContext() {
    return this.laneRootContextName;
  }

  firstEpochDescription(epoch, statusAnchorSha) {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('cloud_state_epoch_invalid');
    return `e=${epoch};a=${assertSha(statusAnchorSha)}`;
  }

  async readFirstEpochPointer(laneRootSha) {
    let observed = null;
    let completed = false;
    for (let page = 1; page <= 2; page += 1) {
      const statuses = await this.request(`/commits/${laneRootSha}/statuses?per_page=${STATUS_PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(statuses)) throw new Error('cloud_state_lane_root_invalid');
      for (const status of statuses) {
        const context = typeof status?.context === 'string' ? status.context.toLowerCase() : '';
        if (context !== this.laneRootContextName.toLowerCase()) continue;
        if (status.state !== 'success' || (status.target_url !== null && status.target_url !== undefined) ||
            typeof status.description !== 'string') {
          throw new Error('cloud_state_lane_root_pointer_invalid');
        }
        const match = /^e=(0|[1-9][0-9]*);a=([a-f0-9]{40})$/i.exec(status.description);
        if (!match) throw new Error('cloud_state_lane_root_pointer_invalid');
        const record = {
          epoch: Number(match[1]),
          statusAnchorSha: assertSha(match[2], 'cloud_state_lane_root_pointer_invalid')
        };
        if (observed && (observed.epoch !== record.epoch || observed.statusAnchorSha !== record.statusAnchorSha)) {
          throw new Error('cloud_state_lane_root_pointer_conflict');
        }
        observed = record;
      }
      if (statuses.length < STATUS_PAGE_SIZE) {
        completed = true;
        break;
      }
    }
    if (!completed) throw new Error('cloud_state_lane_root_status_limit');
    return observed;
  }

  epochRegistrationContext() {
    return this.epochRegistrationContextName;
  }

  epochSealContext() {
    return this.epochSealContextName;
  }

  epochNextContext() {
    return this.epochNextContextName;
  }

  epochAuthorityContext(epoch, generation) {
    if (epochForGeneration(generation) !== epoch) throw new Error('cloud_state_epoch_generation_mismatch');
    return `${this.epochAuthorityPrefix}${epoch}/${generation}`;
  }

  epochAnchorTag(epoch) {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('cloud_state_epoch_invalid');
    return `${this.epochAnchorPrefix}${epoch}`;
  }

  registrationDescription(
    epoch,
    stateAnchorSha,
    baseGeneration,
    startGeneration,
    authorityAnchorSha
  ) {
    if (!Number.isSafeInteger(epoch) || epoch < 0 ||
        !Number.isSafeInteger(baseGeneration) || baseGeneration < 0 ||
        !Number.isSafeInteger(startGeneration) || startGeneration !== baseGeneration + 1 ||
        epochForGeneration(startGeneration) !== epoch) {
      throw new Error('cloud_state_epoch_registration_invalid');
    }
    return `e=${epoch};a=${assertSha(stateAnchorSha)};b=${baseGeneration};s=${startGeneration};u=${assertSha(authorityAnchorSha)}`;
  }

  sealDescription(stateSha, generation, baseWitnessSha) {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('cloud_state_generation_invalid');
    return `s=${assertSha(stateSha)};g=${generation};b=${assertSha(baseWitnessSha, 'cloud_state_base_witness_invalid')}`;
  }

  nextDescription(epoch, statusAnchorSha) {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('cloud_state_epoch_invalid');
    return `e=${epoch};a=${assertSha(statusAnchorSha)}`;
  }

  authorityDescription(stateSha, parentSha, baseWitnessSha) {
    return `s=${assertSha(stateSha)};p=${assertSha(parentSha)};b=${assertSha(baseWitnessSha, 'cloud_state_base_witness_invalid')}`;
  }

  parseEpochStatus(status, expectedStatusAnchorSha) {
    const context = typeof status?.context === 'string' ? status.context.toLowerCase() : '';
    const registrationContext = this.epochRegistrationContextName.toLowerCase();
    const sealContext = this.epochSealContextName.toLowerCase();
    const nextContext = this.epochNextContextName.toLowerCase();
    const authorityPrefix = this.epochAuthorityPrefix.toLowerCase();

    if (status?.state !== 'success' || (status.target_url !== null && status.target_url !== undefined) ||
        typeof status.description !== 'string') {
      if (context === registrationContext || context === sealContext || context === nextContext ||
          context.startsWith(authorityPrefix)) {
        throw new Error('cloud_state_epoch_status_invalid');
      }
      return null;
    }

    if (context === registrationContext) {
      const match = /^e=(0|[1-9][0-9]*);a=([a-f0-9]{40});b=(0|[1-9][0-9]*);s=([1-9][0-9]*);u=([a-f0-9]{40})$/i.exec(status.description);
      if (!match) throw new Error('cloud_state_epoch_registration_invalid');
      const epoch = Number(match[1]);
      const stateAnchorSha = assertSha(match[2], 'cloud_state_epoch_registration_invalid');
      const baseGeneration = Number(match[3]);
      const startGeneration = Number(match[4]);
      const authorityAnchorSha = assertSha(match[5], 'cloud_state_epoch_registration_invalid');
      if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(baseGeneration) ||
          !Number.isSafeInteger(startGeneration) || startGeneration !== baseGeneration + 1 ||
          epochForGeneration(startGeneration) !== epoch) {
        throw new Error('cloud_state_epoch_registration_invalid');
      }
      return {
        kind: 'registration',
        epoch,
        anchorSha: stateAnchorSha,
        baseGeneration,
        startGeneration,
        statusAnchorSha: assertSha(expectedStatusAnchorSha),
        authorityAnchorSha
      };
    }

    if (context === sealContext) {
      const match = /^s=([a-f0-9]{40});g=([1-9][0-9]*);b=([a-f0-9]{40})$/i.exec(status.description);
      if (!match) throw new Error('cloud_state_epoch_seal_invalid');
      const stateSha = assertSha(match[1], 'cloud_state_epoch_seal_invalid');
      const generation = Number(match[2]);
      const baseWitnessSha = assertSha(match[3], 'cloud_state_base_witness_invalid');
      if (!Number.isSafeInteger(generation)) throw new Error('cloud_state_epoch_seal_invalid');
      return { kind: 'seal', stateSha, generation, baseWitnessSha };
    }

    if (context === nextContext) {
      const match = /^e=(0|[1-9][0-9]*);a=([a-f0-9]{40})$/i.exec(status.description);
      if (!match) throw new Error('cloud_state_epoch_next_invalid');
      return {
        kind: 'next',
        epoch: Number(match[1]),
        statusAnchorSha: assertSha(match[2], 'cloud_state_epoch_next_invalid')
      };
    }

    if (context.startsWith(authorityPrefix)) {
      const suffix = context.slice(authorityPrefix.length);
      const matchContext = /^(0|[1-9][0-9]*)\/([1-9][0-9]*)$/.exec(suffix);
      if (!matchContext) throw new Error('cloud_state_epoch_authority_invalid');
      const epoch = Number(matchContext[1]);
      const generation = Number(matchContext[2]);
      if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(generation) ||
          epochForGeneration(generation) !== epoch) {
        throw new Error('cloud_state_epoch_authority_invalid');
      }
      const match = /^s=([a-f0-9]{40});p=([a-f0-9]{40});b=([a-f0-9]{40})$/i.exec(status.description);
      if (!match) throw new Error('cloud_state_epoch_authority_invalid');
      return {
        kind: 'authority',
        epoch,
        generation,
        stateSha: assertSha(match[1], 'cloud_state_epoch_authority_invalid'),
        parentSha: assertSha(match[2], 'cloud_state_epoch_authority_invalid'),
        baseWitnessSha: assertSha(match[3], 'cloud_state_base_witness_invalid')
      };
    }

    const lanePrefix = `${LEDGER_CONTEXT_ROOT}/${this.ledgerDigest}/`.toLowerCase();
    if (context.startsWith(lanePrefix)) throw new Error('cloud_state_epoch_status_invalid');
    return null;
  }

  async readEpochBundle(statusAnchorSha, expectedPreviousStatusAnchorSha = undefined) {
    const anchorSha = assertSha(statusAnchorSha, 'cloud_state_epoch_anchor_invalid');
    const commit = await this.readCommit(anchorSha);
    if (expectedPreviousStatusAnchorSha === null) {
      if (commit.parents.length !== 0) throw new Error('cloud_state_epoch_anchor_invalid');
    } else if (expectedPreviousStatusAnchorSha !== undefined) {
      const previous = assertSha(expectedPreviousStatusAnchorSha, 'cloud_state_epoch_anchor_invalid');
      if (commit.parents.length !== 1 ||
          assertSha(commit.parents[0]?.sha, 'cloud_state_epoch_anchor_invalid') !== previous) {
        throw new Error('cloud_state_epoch_anchor_invalid');
      }
    }

    let registration = null;
    let seal = null;
    let next = null;
    let completed = false;

    for (let page = 1; page <= 2; page += 1) {
      const statuses = await this.request(`/commits/${anchorSha}/statuses?per_page=${STATUS_PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(statuses)) throw new Error('cloud_state_epoch_status_invalid');
      for (const status of statuses) {
        const record = this.parseEpochStatus(status, anchorSha);
        if (!record) continue;
        if (record.kind === 'authority') throw new Error('cloud_state_epoch_status_invalid');
        if (record.kind === 'registration') {
          const previousStatusAnchorSha = commit.parents.length === 1
            ? assertSha(commit.parents[0]?.sha, 'cloud_state_epoch_anchor_invalid')
            : null;
          const normalizedRegistration = { ...record, previousStatusAnchorSha };
          if (registration && JSON.stringify(registration) !== JSON.stringify(normalizedRegistration)) {
            throw new Error('cloud_state_epoch_registration_conflict');
          }
          registration = normalizedRegistration;
        } else if (record.kind === 'seal') {
          if (seal && (
            seal.stateSha !== record.stateSha ||
            seal.generation !== record.generation ||
            seal.baseWitnessSha !== record.baseWitnessSha
          )) {
            throw new Error('cloud_state_epoch_seal_conflict');
          }
          seal = record;
        } else if (record.kind === 'next') {
          if (next && (next.epoch !== record.epoch || next.statusAnchorSha !== record.statusAnchorSha)) {
            throw new Error('cloud_state_epoch_next_conflict');
          }
          next = record;
        }
      }
      if (statuses.length < STATUS_PAGE_SIZE) {
        completed = true;
        break;
      }
    }
    if (!completed) throw new Error('cloud_state_epoch_metadata_limit');
    if (!registration) throw new Error('cloud_state_epoch_registration_missing');
    if (registration.statusAnchorSha !== anchorSha) throw new Error('cloud_state_epoch_anchor_invalid');
    if (commit.message !== this.epochMetadataMessage(registration.epoch)) {
      throw new Error('cloud_state_epoch_anchor_identity_invalid');
    }
    if (expectedPreviousStatusAnchorSha !== undefined &&
        registration.previousStatusAnchorSha !== expectedPreviousStatusAnchorSha) {
      throw new Error('cloud_state_epoch_chain_invalid');
    }

    if (seal) {
      if (seal.generation !== epochEndGeneration(registration.epoch) ||
          epochForGeneration(seal.generation) !== registration.epoch) {
        throw new Error('cloud_state_epoch_seal_invalid');
      }
    }
    if (next && next.epoch !== registration.epoch + 1) throw new Error('cloud_state_epoch_next_invalid');
    return { registration, seal, next };
  }

  async readRootEvidence({ repairLinks = false } = {}) {
    const laneRoot = await this.laneRootCommit();
    if (!laneRoot) {
      return {
        registrations: [],
        registrationByEpoch: new Map(),
        seals: new Map(),
        statusAnchorByEpoch: new Map()
      };
    }
    const first = await this.readFirstEpochPointer(laneRoot.sha);
    if (!first) throw new Error('cloud_state_lane_initialized_incomplete');
    const firstStatusAnchorSha = first.statusAnchorSha;

    const registrations = [];
    const registrationByEpoch = new Map();
    const seals = new Map();
    const statusAnchorByEpoch = new Map();
    const seenAnchors = new Set();
    let currentStatusAnchorSha = firstStatusAnchorSha;
    let expectedPreviousStatusAnchorSha = null;

    while (currentStatusAnchorSha) {
      if (seenAnchors.has(currentStatusAnchorSha)) throw new Error('cloud_state_epoch_chain_invalid');
      seenAnchors.add(currentStatusAnchorSha);
      const bundle = await this.readEpochBundle(currentStatusAnchorSha, expectedPreviousStatusAnchorSha);
      const registration = bundle.registration;
      if (registrations.length === 0 && registration.epoch !== first.epoch) {
        throw new Error('cloud_state_lane_root_pointer_invalid');
      }
      if (registrationByEpoch.has(registration.epoch)) throw new Error('cloud_state_epoch_registration_conflict');
      if (registrations.length > 0) {
        const previous = registrations.at(-1);
        const previousSeal = seals.get(previous.epoch);
        if (!previousSeal ||
            registration.epoch !== previous.epoch + 1 ||
            registration.anchorSha !== previousSeal.stateSha ||
            registration.baseGeneration !== previousSeal.generation ||
            registration.startGeneration !== previousSeal.generation + 1) {
          throw new Error('cloud_state_epoch_chain_invalid');
        }
      }

      registrations.push(registration);
      registrationByEpoch.set(registration.epoch, registration);
      statusAnchorByEpoch.set(registration.epoch, registration.statusAnchorSha);
      if (bundle.seal) seals.set(registration.epoch, { ...bundle.seal, epoch: registration.epoch });

      let nextStatusAnchorSha = bundle.next?.statusAnchorSha ?? null;
      if (!nextStatusAnchorSha && bundle.seal) {
        const discovered = await this.refSha(`tags/${encodeURIComponent(this.epochAnchorTag(registration.epoch + 1))}`);
        if (discovered) {
          const nextBundle = await this.readEpochBundle(discovered, registration.statusAnchorSha);
          if (nextBundle.registration.epoch !== registration.epoch + 1 ||
              nextBundle.registration.anchorSha !== bundle.seal.stateSha ||
              nextBundle.registration.baseGeneration !== bundle.seal.generation ||
              nextBundle.registration.startGeneration !== bundle.seal.generation + 1) {
            throw new Error('cloud_state_epoch_chain_invalid');
          }
          if (!repairLinks) throw new Error('cloud_state_epoch_next_missing');

          // The mutable discovery ref is not authority. Before converting it into the
          // immutable epoch-chain next link, revalidate the sealed fallback against
          // the current trusted lineage. This keeps a stale/force-moved base or a
          // transient base read from causing durable repair publication.
          const sealedEnvelope = await this.readEnvelopeAt(bundle.seal.stateSha);
          if (sealedEnvelope.version !== 2 || sealedEnvelope.generation !== bundle.seal.generation) {
            throw new Error('cloud_state_epoch_seal_mismatch');
          }
          await this.validateLineageAnchor(sealedEnvelope, { baseWitnessSha: bundle.seal.baseWitnessSha });

          const repairError = await this.appendEpochStatus(
            registration.statusAnchorSha,
            this.epochNextContext(),
            this.nextDescription(registration.epoch + 1, discovered)
          );
          if (repairError) throw new Error('cloud_state_epoch_next_repair_failed', { cause: repairError });
          const repairedBundle = await this.readEpochBundle(registration.statusAnchorSha, expectedPreviousStatusAnchorSha);
          if (repairedBundle.next?.statusAnchorSha !== discovered) {
            throw new Error('cloud_state_epoch_next_repair_failed');
          }
          nextStatusAnchorSha = discovered;
        }
      }
      if (nextStatusAnchorSha) {
        if (!bundle.seal) throw new Error('cloud_state_epoch_next_invalid');
        expectedPreviousStatusAnchorSha = registration.statusAnchorSha;
        currentStatusAnchorSha = nextStatusAnchorSha;
      } else {
        currentStatusAnchorSha = null;
      }
    }

    return { registrations, registrationByEpoch, seals, statusAnchorByEpoch };
  }

  async readEpochEvidence({ repairLinks = false } = {}) {
    const root = await this.readRootEvidence({ repairLinks });
    if (root.registrations.length === 0) {
      return { ...root, activeRegistration: null, activeAuthorities: [], authority: null, authorityRegistration: null };
    }
    const activeRegistration = root.registrations.at(-1);
    const activeAuthorities = await this.readEpochAuthorities(activeRegistration);
    let authority = activeAuthorities.at(-1) ?? null;
    let authorityRegistration = authority ? activeRegistration : null;
    if (!authority && root.registrations.length > 1) {
      const previousRegistration = root.registrations.at(-2);
      const previousSeal = root.seals.get(previousRegistration.epoch);
      if (!previousSeal) throw new Error('cloud_state_epoch_chain_invalid');
      authority = {
        generation: previousSeal.generation,
        stateSha: previousSeal.stateSha,
        parentSha: null,
        baseWitnessSha: previousSeal.baseWitnessSha,
        sealed: true
      };
      authorityRegistration = previousRegistration;
    }
    return { ...root, activeRegistration, activeAuthorities, authority, authorityRegistration };
  }

  epochMetadataMessage(epoch) {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('cloud_state_epoch_invalid');
    return `Cloud State v2 metadata ${this.ledgerFullDigest} epoch ${epoch}`;
  }

  epochAuthorityMessage(epoch) {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('cloud_state_epoch_invalid');
    return `Cloud State v2 authority ${this.ledgerFullDigest} epoch ${epoch}`;
  }

  async createEpochStatusAnchors(epoch, previousStatusAnchorSha = null) {
    const template = await this.readCommit(previousStatusAnchorSha ?? LEDGER_ROOT_SHA);
    const treeSha = assertSha(template?.tree?.sha, 'cloud_state_epoch_anchor_invalid');
    const parents = previousStatusAnchorSha ? [assertSha(previousStatusAnchorSha)] : [];
    const metadataCommit = await this.request('/git/commits', {
      method: 'POST',
      body: {
        message: this.epochMetadataMessage(epoch),
        tree: treeSha,
        parents
      }
    });
    const statusAnchorSha = assertSha(metadataCommit?.sha, 'cloud_state_epoch_anchor_invalid');
    const authorityCommit = await this.request('/git/commits', {
      method: 'POST',
      body: {
        message: this.epochAuthorityMessage(epoch),
        tree: treeSha,
        parents: [statusAnchorSha]
      }
    });
    return {
      statusAnchorSha,
      authorityAnchorSha: assertSha(authorityCommit?.sha, 'cloud_state_epoch_authority_anchor_invalid')
    };
  }

  async claimEpochAnchorRef(refName, statusAnchorSha) {
    const target = assertSha(statusAnchorSha);
    let created;
    try {
      created = await this.request('/git/refs', {
        method: 'POST',
        body: { ref: `refs/tags/${refName}`, sha: target }
      });
    } catch (error) {
      throw new Error('cloud_state_epoch_anchor_claim_failed', { cause: error });
    }
    if (created?.ref !== `refs/tags/${refName}` ||
        assertSha(created?.object?.sha, 'cloud_state_epoch_anchor_claim_unproven') !== target) {
      throw new Error('cloud_state_epoch_anchor_claim_unproven');
    }
    const observed = await this.refSha(`tags/${encodeURIComponent(refName)}`);
    if (observed !== target) throw new Error('cloud_state_epoch_anchor_claim_unproven');
  }

  async appendEpochStatus(statusAnchorSha, context, description) {
    let postError = null;
    try {
      await this.request(`/statuses/${assertSha(statusAnchorSha)}`, {
        method: 'POST',
        body: { state: 'success', context, description }
      });
    } catch (error) {
      postError = error;
    }
    return postError;
  }

  async ensureEpochRegistration(epoch, stateAnchorSha, baseGeneration, startGeneration, observedRoot = null) {
    const root = observedRoot ?? await this.readRootEvidence();
    const existing = root.registrationByEpoch.get(epoch);
    if (existing) {
      if (existing.anchorSha === assertSha(stateAnchorSha) &&
          existing.baseGeneration === baseGeneration &&
          existing.startGeneration === startGeneration) {
        return { root, registration: existing };
      }
      throw new Error('cloud_state_epoch_registration_conflict');
    }

    const previousRegistration = root.registrations.at(-1) ?? null;
    if (previousRegistration) {
      const previousSeal = root.seals.get(previousRegistration.epoch);
      if (!previousSeal ||
          epoch !== previousRegistration.epoch + 1 ||
          stateAnchorSha !== previousSeal.stateSha ||
          baseGeneration !== previousSeal.generation ||
          startGeneration !== previousSeal.generation + 1) {
        throw new Error('cloud_state_epoch_chain_invalid');
      }
    } else if (root.registrations.length !== 0) {
      throw new Error('cloud_state_epoch_chain_invalid');
    }

    const previousStatusAnchorSha = previousRegistration?.statusAnchorSha ?? null;
    const { statusAnchorSha, authorityAnchorSha } = await this.createEpochStatusAnchors(epoch, previousStatusAnchorSha);
    await this.claimEpochAnchorRef(this.epochAnchorTag(epoch), statusAnchorSha);

    const registrationError = await this.appendEpochStatus(
      statusAnchorSha,
      this.epochRegistrationContext(),
      this.registrationDescription(
        epoch,
        stateAnchorSha,
        baseGeneration,
        startGeneration,
        authorityAnchorSha
      )
    );
    if (registrationError) throw new Error('cloud_state_epoch_registration_append_failed', { cause: registrationError });

    if (previousRegistration) {
      const nextError = await this.appendEpochStatus(
        previousRegistration.statusAnchorSha,
        this.epochNextContext(),
        this.nextDescription(epoch, statusAnchorSha)
      );
      if (nextError) throw new Error('cloud_state_epoch_next_append_failed', { cause: nextError });
    } else {
      const laneRoot = await this.laneRootCommit({ create: true });
      const firstPointerError = await this.appendEpochStatus(
        laneRoot.sha,
        this.laneRootContext(),
        this.firstEpochDescription(epoch, statusAnchorSha)
      );
      if (firstPointerError) throw new Error('cloud_state_lane_root_pointer_append_failed', { cause: firstPointerError });
    }

    const after = await this.readRootEvidence();
    const observed = after.registrationByEpoch.get(epoch);
    if (!observed ||
        observed.statusAnchorSha !== statusAnchorSha ||
        observed.authorityAnchorSha !== authorityAnchorSha ||
        observed.anchorSha !== stateAnchorSha ||
        observed.baseGeneration !== baseGeneration ||
        observed.startGeneration !== startGeneration) {
      throw new Error('cloud_state_epoch_registration_conflict');
    }
    return { root: after, registration: observed };
  }

  async readEpochAuthorities(registration) {
    const authorityAnchorSha = assertSha(registration.authorityAnchorSha, 'cloud_state_epoch_authority_anchor_invalid');
    const authorityCommit = await this.readCommit(authorityAnchorSha);
    if (authorityCommit.parents.length !== 1 ||
        assertSha(authorityCommit.parents[0]?.sha, 'cloud_state_epoch_authority_anchor_invalid') !== registration.statusAnchorSha) {
      throw new Error('cloud_state_epoch_authority_anchor_invalid');
    }
    if (authorityCommit.message !== this.epochAuthorityMessage(registration.epoch)) {
      throw new Error('cloud_state_epoch_authority_anchor_identity_invalid');
    }

    const byGeneration = new Map();
    let completed = false;
    for (let page = 1; page <= EPOCH_STATUS_MAX_PAGES; page += 1) {
      const statuses = await this.request(`/commits/${authorityAnchorSha}/statuses?per_page=${STATUS_PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(statuses)) throw new Error('cloud_state_epoch_authority_invalid');
      for (const status of statuses) {
        const record = this.parseEpochStatus(status, registration.statusAnchorSha);
        if (!record) continue;
        if (record.kind !== 'authority') throw new Error('cloud_state_epoch_authority_invalid');
        if (record.epoch !== registration.epoch ||
            record.generation < registration.startGeneration ||
            record.generation > epochEndGeneration(registration.epoch)) {
          throw new Error('cloud_state_epoch_authority_invalid');
        }
        const previous = byGeneration.get(record.generation);
        if (previous && (
          previous.stateSha !== record.stateSha ||
          previous.parentSha !== record.parentSha ||
          previous.baseWitnessSha !== record.baseWitnessSha
        )) {
          throw new Error('cloud_state_epoch_authority_conflict');
        }
        byGeneration.set(record.generation, record);
      }
      if (statuses.length < STATUS_PAGE_SIZE) {
        completed = true;
        break;
      }
    }
    if (!completed) throw new Error('cloud_state_epoch_status_limit');
    const authorities = [...byGeneration.values()].sort((a, b) => a.generation - b.generation);
    for (let index = 0; index < authorities.length; index += 1) {
      const current = authorities[index];
      const expectedGeneration = registration.startGeneration + index;
      const expectedParent = index === 0 ? registration.anchorSha : authorities[index - 1].stateSha;
      if (current.generation !== expectedGeneration || current.parentSha !== expectedParent) {
        throw new Error('cloud_state_epoch_authority_gap');
      }
    }
    return authorities;
  }

  async ensureEpochSeal(registration, authority, observedRoot = null) {
    if (!authority ||
        authority.generation !== epochEndGeneration(registration.epoch) ||
        epochForGeneration(authority.generation) !== registration.epoch) {
      throw new Error('cloud_state_epoch_seal_invalid');
    }
    const root = observedRoot ?? await this.readRootEvidence();
    const existing = root.seals.get(registration.epoch);
    if (existing) {
      if (existing.stateSha === authority.stateSha &&
          existing.generation === authority.generation &&
          existing.baseWitnessSha === authority.baseWitnessSha) return root;
      throw new Error('cloud_state_epoch_seal_conflict');
    }
    const postError = await this.appendEpochStatus(
      registration.statusAnchorSha,
      this.epochSealContext(),
      this.sealDescription(authority.stateSha, authority.generation, authority.baseWitnessSha)
    );
    if (postError) throw new Error('cloud_state_epoch_seal_append_failed', { cause: postError });
    const after = await this.readRootEvidence();
    const observed = after.seals.get(registration.epoch);
    if (!observed ||
        observed.stateSha !== authority.stateSha ||
        observed.generation !== authority.generation ||
        observed.baseWitnessSha !== authority.baseWitnessSha) {
      throw new Error('cloud_state_epoch_seal_conflict');
    }
    return after;
  }

  generationClaimTag(generation) {
    const epoch = epochForGeneration(generation);
    return `${this.claimPrefix}${epoch}/${generation}`;
  }

  async claimGenerationStrict(generation, candidateSha) {
    const target = assertSha(candidateSha);
    const claimTag = this.generationClaimTag(generation);
    let created;
    try {
      created = await this.request('/git/refs', {
        method: 'POST',
        body: { ref: `refs/tags/${claimTag}`, sha: target }
      });
    } catch (error) {
      throw new Error('cloud_state_generation_claim_failed', { cause: error });
    }
    const createdRef = typeof created?.ref === 'string' ? created.ref : '';
    const createdSha = assertSha(created?.object?.sha, 'cloud_state_generation_claim_unproven');
    if (createdRef !== `refs/tags/${claimTag}` || createdSha !== target) {
      throw new Error('cloud_state_generation_claim_unproven');
    }
    const observed = await this.refSha(`tags/${encodeURIComponent(claimTag)}`);
    if (observed !== target) throw new Error('cloud_state_generation_claim_unproven');
    return claimTag;
  }

  async appendEpochAuthorityAfterClaim(registration, generation, stateSha, parentSha, preClaimAuthorities, lineageEnvelope, { beforeCommit = null } = {}) {
    if (beforeCommit !== null && typeof beforeCommit !== 'function') throw new Error('cloud_state_before_commit_invalid');
    const desired = {
      generation,
      stateSha: assertSha(stateSha),
      parentSha: assertSha(parentSha),
      baseWitnessSha: null
    };
    if (epochForGeneration(generation) !== registration.epoch) throw new Error('cloud_state_epoch_generation_mismatch');
    if (!Array.isArray(preClaimAuthorities)) throw new Error('cloud_state_epoch_authority_invalid');
    if (preClaimAuthorities.some((record) => record.generation === generation)) {
      throw new Error('cloud_state_epoch_authority_conflict');
    }

    const before = await this.readEpochAuthorities(registration);
    if (JSON.stringify(before) !== JSON.stringify(preClaimAuthorities)) {
      throw new Error('cloud_state_epoch_authority_conflict');
    }

    // Capture the exact base revision once and bind the immutable authority to
    // that observation. A later movement of the mutable branch cannot
    // retroactively invalidate or authorize this status.
    const baseWitnessSha = await this.baseBranchSha();
    await this.validateLineageAnchor(lineageEnvelope, { baseWitnessSha });
    desired.baseWitnessSha = baseWitnessSha;

    if (beforeCommit) await beforeCommit();
    let postError = null;
    try {
      await this.request(`/statuses/${registration.authorityAnchorSha}`, {
        method: 'POST',
        body: {
          state: 'success',
          context: this.epochAuthorityContext(registration.epoch, generation),
          description: this.authorityDescription(stateSha, parentSha, baseWitnessSha)
        }
      });
    } catch (error) {
      postError = error;
    }
    const after = await this.readEpochAuthorities(registration);
    const observed = after.find((record) => record.generation === generation);
    if (observed?.stateSha === desired.stateSha &&
        observed?.parentSha === desired.parentSha &&
        observed?.baseWitnessSha === desired.baseWitnessSha) return after;
    if (observed) throw new Error('cloud_state_epoch_authority_conflict', { cause: postError ?? undefined });
    if (postError) throw postError;
    throw new Error('cloud_state_epoch_authority_append_failed');
  }

  async validateLegacyMigrationHead(stateSha, stateEnvelope) {
    if (stateEnvelope.version !== 1) throw new Error('cloud_state_legacy_history_invalid');
    const commit = await this.readCommit(stateSha);
    if (commit.parents.length !== 1) throw new Error('cloud_state_history_fork');
  }

  async validateLineageAnchor(stateEnvelope, { baseWitnessSha = null } = {}) {
    const anchorSha = assertSha(stateEnvelope.lineageBaseSha, 'cloud_state_lineage_anchor_invalid');
    const anchorGeneration = stateEnvelope.lineageBaseGeneration;
    if (!Number.isInteger(anchorGeneration) || anchorGeneration < 0 || anchorGeneration >= stateEnvelope.generation) {
      throw new Error('cloud_state_lineage_anchor_invalid');
    }
    if (anchorGeneration === 0) {
      const observedBaseSha = baseWitnessSha
        ? assertSha(baseWitnessSha, 'cloud_state_base_witness_invalid')
        : await this.baseBranchSha();
      const relation = await this.compareCommits(anchorSha, observedBaseSha);
      if (!['identical', 'ahead'].includes(relation)) throw new Error('cloud_state_bootstrap_ancestry_invalid');
      return { anchorSha, anchorGeneration, baseWitnessSha: observedBaseSha };
    }
    const anchorEnvelope = await this.readEnvelopeAt(anchorSha);
    if (anchorEnvelope.version !== 1 || anchorEnvelope.generation !== anchorGeneration) {
      throw new Error('cloud_state_lineage_anchor_invalid');
    }
    await this.validateLegacyMigrationHead(anchorSha, anchorEnvelope);
    if (baseWitnessSha) await this.readCommit(assertSha(baseWitnessSha, 'cloud_state_base_witness_invalid'));
    return { anchorSha, anchorGeneration, baseWitnessSha: baseWitnessSha ? assertSha(baseWitnessSha) : null };
  }

  async validateV2Edge(parentSha, parentEnvelope, childSha, childEnvelope) {
    if (childEnvelope.version !== 2) throw new Error('cloud_state_v2_required');
    const commit = await this.readCommit(childSha);
    if (commit.parents.length !== 1 || assertSha(commit.parents[0]?.sha, 'cloud_state_parent_invalid') !== parentSha) {
      throw new Error('cloud_state_history_fork');
    }
    if (childEnvelope.generation !== parentEnvelope.generation + 1) throw new Error('cloud_state_generation_discontinuity');
    if (parentEnvelope.version === 2) {
      if (assertSha(childEnvelope.lineageBaseSha, 'cloud_state_lineage_anchor_invalid') !==
            assertSha(parentEnvelope.lineageBaseSha, 'cloud_state_lineage_anchor_invalid') ||
          childEnvelope.lineageBaseGeneration !== parentEnvelope.lineageBaseGeneration) {
        throw new Error('cloud_state_lineage_anchor_mismatch');
      }
    } else if (parentEnvelope.version === 1) {
      if (assertSha(childEnvelope.lineageBaseSha, 'cloud_state_lineage_anchor_invalid') !== parentSha ||
          childEnvelope.lineageBaseGeneration !== parentEnvelope.generation) {
        throw new Error('cloud_state_lineage_anchor_mismatch');
      }
    } else {
      throw new Error('cloud_state_history_invalid');
    }
  }

  async validateEpochLineage(registration, authority, authorities, rootEvidence) {
    if (!authority || !Array.isArray(authorities) || authorities.length < 1) {
      throw new Error('cloud_state_epoch_authority_missing');
    }
    const latest = authorities.at(-1);
    if (latest.generation !== authority.generation || latest.stateSha !== authority.stateSha) {
      throw new Error('cloud_state_epoch_authority_mismatch');
    }
    const firstRegistration = rootEvidence.registrations[0];
    if (!firstRegistration) throw new Error('cloud_state_epoch_registration_missing');
    const stateEnvelope = await this.readEnvelopeAt(authority.stateSha);
    if (stateEnvelope.version !== 2 || stateEnvelope.generation !== authority.generation ||
        assertSha(stateEnvelope.lineageBaseSha, 'cloud_state_lineage_anchor_invalid') !== firstRegistration.anchorSha ||
        stateEnvelope.lineageBaseGeneration !== firstRegistration.baseGeneration) {
      throw new Error('cloud_state_lineage_anchor_mismatch');
    }
    await this.validateLineageAnchor(stateEnvelope, { baseWitnessSha: latest.baseWitnessSha });
    if (this.validatedLineageHeads.has(authority.stateSha)) return;

    const authorityByGeneration = new Map(authorities.map((record) => [record.generation, record]));
    let expectedSha = authority.stateSha;
    let expectedGeneration = authority.generation;
    const stepCount = authority.generation - registration.startGeneration + 1;
    if (!Number.isSafeInteger(stepCount) || stepCount < 1 || stepCount > EPOCH_SIZE) {
      throw new Error('cloud_state_history_page_limit');
    }

    let done = false;
    for (let step = 0; step < stepCount; step += 1) {
      const commit = await this.readCommit(expectedSha);
      if (!Array.isArray(commit.parents) || commit.parents.length !== 1) {
        throw new Error('cloud_state_history_fork');
      }
      const parentSha = assertSha(commit.parents[0]?.sha, 'cloud_state_parent_invalid');
      const envelope = step === 0 ? stateEnvelope : await this.readEnvelopeAt(expectedSha);
      if (envelope.version !== 2 || envelope.generation !== expectedGeneration) {
        throw new Error('cloud_state_generation_discontinuity');
      }
      if (assertSha(envelope.lineageBaseSha, 'cloud_state_lineage_anchor_invalid') !== firstRegistration.anchorSha ||
          envelope.lineageBaseGeneration !== firstRegistration.baseGeneration) {
        throw new Error('cloud_state_lineage_anchor_mismatch');
      }
      const authorityRecord = authorityByGeneration.get(expectedGeneration);
      if (!authorityRecord || authorityRecord.stateSha !== expectedSha || authorityRecord.parentSha !== parentSha) {
        throw new Error('cloud_state_epoch_authority_mismatch');
      }
      if (expectedGeneration === registration.startGeneration) {
        if (parentSha !== registration.anchorSha) throw new Error('cloud_state_history_invalid');
        done = true;
        break;
      }
      expectedSha = parentSha;
      expectedGeneration -= 1;
    }

    if (!done) throw new Error('cloud_state_history_incomplete');
    this.validatedLineageHeads.add(authority.stateSha);
  }

  snapshotFrom(stateSha, checkpointSha, witnessSha, envelope, authority = null) {
    return {
      refSha: stateSha,
      checkpointSha,
      witnessSha,
      authoritySha: authority?.stateSha ?? null,
      authorityGeneration: authority?.generation ?? 0,
      generation: envelope?.generation ?? 0,
      envelopeVersion: envelope?.version ?? null,
      state: envelope?.state ?? emptyState()
    };
  }

  async advanceRef(refName, expectedSha, targetSha, failureCode = null) {
    let error = null;
    try {
      if (expectedSha) {
        await this.request(`/git/refs/tags/${encodeURIComponent(refName)}`, {
          method: 'PATCH',
          body: { sha: targetSha, force: false }
        });
      } else {
        await this.request('/git/refs', {
          method: 'POST',
          body: { ref: `refs/tags/${refName}`, sha: targetSha }
        });
      }
    } catch (caught) {
      error = caught;
    }
    const observed = await this.refSha(`tags/${encodeURIComponent(refName)}`);
    if (observed === targetSha) return;
    if (failureCode) throw new Error(failureCode, { cause: error ?? undefined });
    if (error) throw error;
    throw new Error('cloud_state_conflict');
  }

  async relationToAuthority(refSha, authoritySha) {
    if (!refSha) return 'missing';
    if (refSha === authoritySha) return 'identical';
    const relation = await this.compareCommits(refSha, authoritySha);
    if (relation === 'ahead') return 'behind';
    if (relation === 'behind') return 'ahead';
    return relation;
  }

  async repairRefToAuthority(refName, currentSha, authoritySha, failureCode) {
    const relation = await this.relationToAuthority(currentSha, authoritySha);
    if (!['missing', 'identical', 'behind'].includes(relation)) throw new Error('cloud_state_history_fork');
    if (relation === 'identical') return;
    await this.advanceRef(refName, currentSha, authoritySha, failureCode);
  }

  async repairAllRefs(refs, authoritySha) {
    const before = await this.readRefs();
    if (before.stateSha !== refs.stateSha || before.checkpointSha !== refs.checkpointSha || before.witnessSha !== refs.witnessSha) {
      throw new Error('cloud_state_conflict');
    }
    await this.repairRefToAuthority(this.tag, before.stateSha, authoritySha, 'cloud_state_state_recovery_failed');
    const afterState = await this.readRefs();
    await this.repairRefToAuthority(this.checkpointTag, afterState.checkpointSha, authoritySha, 'cloud_state_checkpoint_recovery_failed');
    const afterCheckpoint = await this.readRefs();
    await this.repairRefToAuthority(this.witnessTag, afterCheckpoint.witnessSha, authoritySha, 'cloud_state_witness_recovery_failed');
    const finalRefs = await this.readRefs();
    if (finalRefs.stateSha !== authoritySha || finalRefs.checkpointSha !== authoritySha || finalRefs.witnessSha !== authoritySha) {
      throw new Error('cloud_state_partial_publication');
    }
    return finalRefs;
  }

  async readSnapshot({ repair = false } = {}) {
    const [refs, evidence] = await Promise.all([this.readRefs(), this.readEpochEvidence({ repairLinks: repair })]);
    const { stateSha, checkpointSha, witnessSha } = refs;

    if (evidence.registrations.length === 0) {
      if (!stateSha && !checkpointSha && !witnessSha) return this.snapshotFrom(null, null, null, null, null);
      if (!stateSha) throw new Error('cloud_state_partial_publication');
      const stateEnvelope = await this.readEnvelopeAt(stateSha);
      if (stateEnvelope.version === 1) {
        if (checkpointSha || witnessSha) throw new Error('cloud_state_legacy_after_migration');
        return this.snapshotFrom(stateSha, null, null, stateEnvelope, null);
      }
      throw new Error('cloud_state_epoch_registration_missing');
    }

    if (!evidence.authority) {
      const registration = evidence.activeRegistration;
      if (evidence.registrations.length !== 1 || checkpointSha || witnessSha) {
        throw new Error('cloud_state_epoch_authority_missing');
      }
      if (!stateSha) {
        if (registration.baseGeneration !== 0) throw new Error('cloud_state_epoch_authority_missing');
        const currentBaseSha = await this.baseBranchSha();
        const relation = await this.compareCommits(registration.anchorSha, currentBaseSha);
        if (!['identical', 'ahead'].includes(relation)) throw new Error('cloud_state_bootstrap_ancestry_invalid');
        return this.snapshotFrom(null, null, null, null, null);
      }
      if (stateSha !== registration.anchorSha) throw new Error('cloud_state_unproven_state_advance');
      const legacyEnvelope = await this.readEnvelopeAt(stateSha);
      if (legacyEnvelope.version !== 1 || legacyEnvelope.generation !== registration.baseGeneration ||
          registration.startGeneration !== legacyEnvelope.generation + 1) {
        throw new Error('cloud_state_epoch_registration_invalid');
      }
      await this.validateLegacyMigrationHead(stateSha, legacyEnvelope);
      return this.snapshotFrom(stateSha, null, null, legacyEnvelope, null);
    }

    const authority = evidence.authority;
    const authorityEnvelope = await this.readEnvelopeAt(authority.stateSha);
    if (authorityEnvelope.version !== 2 || authorityEnvelope.generation !== authority.generation) {
      throw new Error('cloud_state_epoch_authority_mismatch');
    }

    const activeEpochAuthority =
      evidence.authorityRegistration === evidence.activeRegistration && evidence.activeAuthorities.length > 0;
    if (activeEpochAuthority) {
      await this.validateEpochLineage(evidence.activeRegistration, authority, evidence.activeAuthorities, evidence);
    } else {
      const seal = evidence.seals.get(evidence.authorityRegistration.epoch);
      if (!seal || seal.stateSha !== authority.stateSha || seal.generation !== authority.generation) {
        throw new Error('cloud_state_epoch_seal_mismatch');
      }
      const firstRegistration = evidence.registrations[0];
      if (assertSha(authorityEnvelope.lineageBaseSha, 'cloud_state_lineage_anchor_invalid') !== firstRegistration.anchorSha ||
          authorityEnvelope.lineageBaseGeneration !== firstRegistration.baseGeneration) {
        throw new Error('cloud_state_lineage_anchor_mismatch');
      }
      await this.validateLineageAnchor(authorityEnvelope, { baseWitnessSha: authority.baseWitnessSha });
    }

    const revalidateSealedFallback = async () => {
      if (!activeEpochAuthority) {
        await this.validateLineageAnchor(authorityEnvelope, { baseWitnessSha: authority.baseWitnessSha });
      }
    };

    if (!stateSha) {
      if (!repair) throw new Error('cloud_state_rollback');
      await revalidateSealedFallback();
      const repaired = await this.repairAllRefs(refs, authority.stateSha);
      return this.snapshotFrom(repaired.stateSha, repaired.checkpointSha, repaired.witnessSha, authorityEnvelope, authority);
    }
    if (stateSha !== authority.stateSha) {
      const relation = await this.relationToAuthority(stateSha, authority.stateSha);
      if (relation === 'behind') {
        if (!repair) throw new Error('cloud_state_rollback');
        await revalidateSealedFallback();
        const repaired = await this.repairAllRefs(refs, authority.stateSha);
        return this.snapshotFrom(repaired.stateSha, repaired.checkpointSha, repaired.witnessSha, authorityEnvelope, authority);
      }
      if (relation === 'ahead') throw new Error('cloud_state_unproven_state_advance');
      throw new Error('cloud_state_history_fork');
    }

    for (const watermarkSha of [checkpointSha, witnessSha]) {
      const relation = await this.relationToAuthority(watermarkSha, authority.stateSha);
      if (!['missing', 'identical', 'behind'].includes(relation)) throw new Error('cloud_state_history_fork');
    }
    if (repair && (checkpointSha !== authority.stateSha || witnessSha !== authority.stateSha)) {
      await revalidateSealedFallback();
      const repaired = await this.repairAllRefs(refs, authority.stateSha);
      return this.snapshotFrom(repaired.stateSha, repaired.checkpointSha, repaired.witnessSha, authorityEnvelope, authority);
    }
    await revalidateSealedFallback();
    return this.snapshotFrom(stateSha, checkpointSha, witnessSha, authorityEnvelope, authority);
  }

  async createStateCommit(envelope, parentSha) {
    const content = JSON.stringify(envelope);
    if (Buffer.byteLength(content, 'utf8') > this.maxBytes * 2) throw new Error('cloud_state_envelope_too_large');
    const parent = await this.readCommit(parentSha);
    const baseTree = assertSha(parent?.tree?.sha, 'cloud_state_base_tree_invalid');
    const blob = await this.request('/git/blobs', { method: 'POST', body: { content, encoding: 'utf-8' } });
    const tree = await this.request('/git/trees', {
      method: 'POST',
      body: {
        base_tree: baseTree,
        tree: [{ path: this.statePath, mode: '100644', type: 'blob', sha: blob.sha }]
      }
    });
    const commit = await this.request('/git/commits', {
      method: 'POST',
      body: { message: 'Update durable agent cloud state', tree: tree.sha, parents: [parentSha] }
    });
    return assertSha(commit?.sha, 'cloud_state_commit_invalid');
  }

  async writeSnapshot(state, snapshot, { beforeCommit = null } = {}) {
    if (beforeCommit !== null && typeof beforeCommit !== 'function') throw new Error('cloud_state_before_commit_invalid');
    validateCloudState(state, { maxBytes: this.maxBytes, allowedProjectIds: this.allowedProjectIds });
    const expectedStateSha = snapshot?.refSha ?? null;
    const expectedCheckpointSha = snapshot?.checkpointSha ?? null;
    const expectedWitnessSha = snapshot?.witnessSha ?? null;
    const [current, initialEvidence] = await Promise.all([this.readRefs(), this.readEpochEvidence()]);
    if (current.stateSha !== expectedStateSha || current.checkpointSha !== expectedCheckpointSha || current.witnessSha !== expectedWitnessSha) {
      throw new Error('cloud_state_conflict');
    }

    let parentSha;
    let generation;
    let lineageBaseSha;
    let lineageBaseGeneration;
    let parentEnvelope;

    if (!expectedStateSha) {
      if (expectedCheckpointSha || expectedWitnessSha || initialEvidence.authority) throw new Error('cloud_state_snapshot_untrusted');
      const orphanRegistration = initialEvidence.registrations.length === 1 ? initialEvidence.registrations[0] : null;
      if (orphanRegistration) {
        if (orphanRegistration.baseGeneration !== 0 || orphanRegistration.startGeneration !== 1) {
          throw new Error('cloud_state_epoch_registration_invalid');
        }
        const currentBaseSha = await this.baseBranchSha();
        const relation = await this.compareCommits(orphanRegistration.anchorSha, currentBaseSha);
        if (!['identical', 'ahead'].includes(relation)) throw new Error('cloud_state_bootstrap_ancestry_invalid');
        parentSha = orphanRegistration.anchorSha;
      } else {
        parentSha = await this.baseBranchSha();
      }
      generation = 1;
      lineageBaseSha = parentSha;
      lineageBaseGeneration = 0;
    } else {
      parentEnvelope = await this.readEnvelopeAt(expectedStateSha);
      if (!expectedCheckpointSha && !expectedWitnessSha && parentEnvelope.version === 1) {
        if (initialEvidence.authority) throw new Error('cloud_state_legacy_after_migration');
        await this.validateLegacyMigrationHead(expectedStateSha, parentEnvelope);
        parentSha = expectedStateSha;
        generation = parentEnvelope.generation + 1;
        lineageBaseSha = expectedStateSha;
        lineageBaseGeneration = parentEnvelope.generation;
      } else {
        const authority = initialEvidence.authority;
        if (parentEnvelope.version !== 2 || !authority ||
            authority.stateSha !== expectedStateSha || authority.generation !== parentEnvelope.generation ||
            expectedCheckpointSha !== expectedStateSha || expectedWitnessSha !== expectedStateSha) {
          throw new Error('cloud_state_snapshot_untrusted');
        }
        if (initialEvidence.authorityRegistration === initialEvidence.activeRegistration && initialEvidence.activeAuthorities.length > 0) {
          await this.validateEpochLineage(initialEvidence.activeRegistration, authority, initialEvidence.activeAuthorities, initialEvidence);
        }
        parentSha = expectedStateSha;
        generation = parentEnvelope.generation + 1;
        lineageBaseSha = assertSha(parentEnvelope.lineageBaseSha, 'cloud_state_lineage_anchor_invalid');
        lineageBaseGeneration = parentEnvelope.lineageBaseGeneration;
      }
    }

    const targetEpoch = epochForGeneration(generation);
    let root = initialEvidence;
    let registration = root.registrationByEpoch.get(targetEpoch) ?? null;

    if (!registration) {
      if (root.registrations.length === 0) {
        const created = await this.ensureEpochRegistration(targetEpoch, parentSha, generation - 1, generation, root);
        root = { ...created.root, activeRegistration: created.registration };
        registration = created.registration;
      } else {
        const lastRegistration = root.registrations.at(-1);
        if (targetEpoch !== lastRegistration.epoch + 1 ||
            generation !== epochEndGeneration(lastRegistration.epoch) + 1 ||
            !initialEvidence.authority || initialEvidence.authority.stateSha !== parentSha ||
            initialEvidence.authority.generation !== generation - 1) {
          throw new Error('cloud_state_epoch_chain_invalid');
        }
        const lastAuthorities = lastRegistration === initialEvidence.activeRegistration
          ? initialEvidence.activeAuthorities
          : await this.readEpochAuthorities(lastRegistration);
        await this.validateEpochLineage(lastRegistration, initialEvidence.authority, lastAuthorities, initialEvidence);
        root = await this.ensureEpochSeal(lastRegistration, initialEvidence.authority, root);
        const created = await this.ensureEpochRegistration(targetEpoch, parentSha, generation - 1, generation, root);
        root = created.root;
        registration = created.registration;
      }
    } else {
      if (registration.anchorSha !== (generation === registration.startGeneration ? parentSha : registration.anchorSha)) {
        throw new Error('cloud_state_epoch_registration_conflict');
      }
      if (generation < registration.startGeneration || generation > epochEndGeneration(registration.epoch)) {
        throw new Error('cloud_state_epoch_generation_mismatch');
      }
    }

    const preClaimAuthorities = await this.readEpochAuthorities(registration);
    const expectedPreviousGeneration = generation - 1;
    if (preClaimAuthorities.some((record) => record.generation >= generation)) throw new Error('cloud_state_epoch_authority_conflict');
    if (generation === registration.startGeneration) {
      if (registration.anchorSha !== parentSha || registration.baseGeneration !== expectedPreviousGeneration) {
        throw new Error('cloud_state_epoch_registration_conflict');
      }
      if (preClaimAuthorities.length !== 0) throw new Error('cloud_state_epoch_authority_conflict');
    } else {
      const previous = preClaimAuthorities.at(-1);
      if (!previous || previous.generation !== expectedPreviousGeneration || previous.stateSha !== parentSha) {
        throw new Error('cloud_state_epoch_authority_gap');
      }
    }

    const envelope = {
      version: 2,
      repository: `${this.repository.owner}/${this.repository.name}`,
      laneId: this.laneId,
      statePath: this.statePath,
      stateTag: this.tag,
      checkpointTag: this.checkpointTag,
      witnessTag: this.witnessTag,
      lineageBaseSha,
      lineageBaseGeneration,
      generation,
      stateHash: stateHash(state),
      updatedAt: new Date(this.now()).toISOString(),
      state
    };
    const commitSha = await this.createStateCommit(envelope, parentSha);

    await this.validateLineageAnchor(envelope);
    try {
      await this.claimGenerationStrict(generation, commitSha);
    } catch (error) {
      throw new Error('cloud_state_generation_election_failed', { cause: error });
    }

    await this.validateLineageAnchor(envelope);

    let authorityError = null;
    let nextAuthorities = null;
    try {
      nextAuthorities = await this.appendEpochAuthorityAfterClaim(
        registration,
        generation,
        commitSha,
        parentSha,
        preClaimAuthorities,
        envelope,
        { beforeCommit }
      );
    } catch (error) {
      authorityError = error;
    }
    if (authorityError) throw new Error('cloud_state_partial_publication', { cause: authorityError });

    const authority = nextAuthorities.at(-1);
    await this.validateEpochLineage(registration, authority, nextAuthorities, root);

    let stateRefError = null;
    let checkpointError = null;
    let witnessError = null;
    try {
      await this.advanceRef(this.tag, expectedStateSha, commitSha, 'cloud_state_partial_publication');
    } catch (error) {
      stateRefError = error;
    }
    try {
      await this.advanceRef(this.checkpointTag, expectedCheckpointSha, commitSha, 'cloud_state_partial_publication');
    } catch (error) {
      checkpointError = error;
    }
    try {
      await this.advanceRef(this.witnessTag, expectedWitnessSha, commitSha, 'cloud_state_partial_publication');
    } catch (error) {
      witnessError = error;
    }

    const [finalRefs, finalAuthorities] = await Promise.all([this.readRefs(), this.readEpochAuthorities(registration)]);
    const finalAuthority = finalAuthorities.at(-1);
    if (finalRefs.stateSha === commitSha && finalRefs.checkpointSha === commitSha && finalRefs.witnessSha === commitSha &&
        finalAuthority?.generation === generation && finalAuthority.stateSha === commitSha && finalAuthority.parentSha === parentSha) {
      this.validatedLineageHeads.add(commitSha);
      return commitSha;
    }
    throw new Error('cloud_state_partial_publication', { cause: stateRefError ?? checkpointError ?? witnessError ?? undefined });
  }

  async load() {
    return (await this.readSnapshot()).state;
  }

  async save() {
    throw new Error('cloud_state_direct_save_forbidden');
  }

  async mutateInternal(mutator, { requireLease, beforeCommit = null, deadlineAt = null }) {
    if (beforeCommit !== null && typeof beforeCommit !== 'function') throw new Error('cloud_state_before_commit_invalid');
    if (deadlineAt !== null && (!Number.isFinite(deadlineAt) || deadlineAt <= 0)) throw new Error('cloud_state_deadline_invalid');
    const operation = async () => {
      const snapshot = await this.readSnapshot({ repair: true });
      const data = snapshot.state;
      if (requireLease) {
        const lease = data.cloudExecutionLease;
        const expiresAt = Date.parse(lease?.expiresAt ?? '');
        if (!this.activeGlobalLeaseId ||
            lease?.leaseId !== this.activeGlobalLeaseId ||
            lease?.ownerId !== this.ownerId ||
            !Number.isFinite(expiresAt) ||
            expiresAt <= this.now()) {
          throw new Error('cloud_global_lease_lost');
        }
        lease.expiresAt = new Date(this.now() + this.leaseTtlMs).toISOString();
      }
      const output = await mutator(data);
      sanitizeRemoteOnlyEvidence(data);
      if (beforeCommit) await beforeCommit();
      await this.writeSnapshot(data, snapshot, { beforeCommit });
      return output;
    };
    if (deadlineAt === null) return operation();
    if (this.now() >= deadlineAt) throw new Error('workflow_deadline_cap_exceeded');
    return this.mutationDeadlineContext.run(deadlineAt, operation);
  }

  async mutate(mutator, { beforeCommit = null, deadlineAt = null } = {}) {
    return this.mutateInternal(mutator, { requireLease: true, beforeCommit, deadlineAt });
  }

  async ownerIdentity() {
    return this.ownerId;
  }

  async lockOwnerIsAbandoned(metadata) {
    const createdAt = Date.parse(metadata?.createdAt ?? '');
    if (!Number.isFinite(createdAt)) return false;
    const ownerIdentity = metadata?.ownerIdentity ?? metadata?.ownerId ?? null;
    if (ownerIdentity === this.ownerId) return false;
    if (this.now() - createdAt >= this.leaseTtlMs) return true;

    const githubOwner = /^github:(\d+):(\d+)$/.exec(String(ownerIdentity ?? ''));
    if (!githubOwner) return false;
    try {
      const run = await this.request(`/actions/runs/${githubOwner[1]}`);
      return run?.status === 'completed';
    } catch {
      return false;
    }
  }

  async claimGlobalLease() {
    const lease = {
      leaseId: randomUUID(),
      ownerId: this.ownerId,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + this.leaseTtlMs).toISOString()
    };
    await this.mutateInternal(async (data) => {
      const existing = data.cloudExecutionLease;
      const existingExpiry = Date.parse(existing?.expiresAt ?? '');
      if (existing && Number.isFinite(existingExpiry) && existingExpiry > this.now()) {
        const abandoned = await this.lockOwnerIsAbandoned({
          ownerIdentity: existing.ownerId,
          createdAt: existing.createdAt
        });
        if (!abandoned) throw new Error('cloud_global_lease_busy');
      }
      data.cloudExecutionLease = lease;
      return lease;
    }, { requireLease: false });
    this.activeGlobalLeaseId = lease.leaseId;
    return lease;
  }

  async releaseGlobalLease(leaseId) {
    const clearLease = () => this.mutateInternal((data) => {
      if (data.cloudExecutionLease?.leaseId !== leaseId || data.cloudExecutionLease?.ownerId !== this.ownerId) return false;
      data.cloudExecutionLease = null;
      return true;
    }, { requireLease: false });
    let released;
    try {
      released = await clearLease();
    } catch (error) {
      let snapshot;
      try {
        snapshot = await this.readSnapshot({ repair: true });
      } catch {
        throw error;
      }
      const current = snapshot.state.cloudExecutionLease;
      if (!current) {
        if (this.activeGlobalLeaseId === leaseId) this.activeGlobalLeaseId = null;
        return true;
      }
      if (current.leaseId !== leaseId || current.ownerId !== this.ownerId) {
        if (this.activeGlobalLeaseId === leaseId) this.activeGlobalLeaseId = null;
        return false;
      }
      throw error;
    }
    if (released && this.activeGlobalLeaseId === leaseId) this.activeGlobalLeaseId = null;
    return released;
  }

  async withGlobalLease(operation) {
    const lease = await this.claimGlobalLease();
    let output;
    let operationError = null;
    try { output = await operation(lease); } catch (error) { operationError = error; }
    let released = false;
    let releaseError = null;
    try { released = await this.releaseGlobalLease(lease.leaseId); } catch (error) { releaseError = error; }
    if (releaseError) throw new Error('cloud_global_lease_release_failed', { cause: releaseError });
    if (!released) throw new Error('cloud_global_lease_lost', { cause: operationError ?? undefined });
    if (operationError) throw operationError;
    return output;
  }
}
