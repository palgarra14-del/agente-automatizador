import { createHash, randomUUID } from 'node:crypto';
import { JsonStore } from './core.js';

const DEFAULT_TAG = 'agent-cloud-state-v1';
const DEFAULT_PATH = '.agent/cloud-state.json';
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_LEASE_TTL_MS = 20 * 60 * 1000;
const HISTORY_PAGE_SIZE = 100;
const HISTORY_MAX_PAGES = 4;
const STATUS_PAGE_SIZE = 100;
const ROOT_STATUS_MAX_PAGES = 20;
const EPOCH_STATUS_MAX_PAGES = 4;
const EPOCH_SIZE = 256;
const CHECKPOINT_NAMESPACE = 'agent-cloud-state-v2-checkpoints';
const WITNESS_NAMESPACE = 'agent-cloud-state-v2-witnesses';
const LEDGER_ROOT_SHA = 'b4f3b2e76e24be58d241227850a5d48ea19c2ea8';
const LEDGER_CONTEXT_ROOT = 'agent-cloud-state-v2';
const RESERVED_STATE_TAGS = new Set([CHECKPOINT_NAMESPACE, WITNESS_NAMESPACE]);

const HISTORY_QUERY = `
query CloudStateHistory($owner: String!, $name: String!, $oid: GitObjectID!, $path: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit {
        history(first: $first, after: $after) {
          nodes {
            oid
            parents(first: 2) { totalCount nodes { oid } }
            file(path: $path) {
              object {
                ... on Blob { oid byteSize isBinary isTruncated text }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
}`;

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
    now = () => Date.now()
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
    this.activeGlobalLeaseId = null;
    this.validatedLineageHeads = new Set();
    this.ledgerRootVerified = false;
    this.ledgerDigest = createHash('sha256').update(JSON.stringify(canonical({
      repository: `${repository.owner}/${repository.name}`,
      laneId,
      statePath,
      stateTag: tag,
      checkpointTag: this.checkpointTag,
      witnessTag: this.witnessTag
    }))).digest('hex').slice(0, 32);
    this.epochRegistrationPrefix = `${LEDGER_CONTEXT_ROOT}/${this.ledgerDigest}/e/`;
    this.epochSealPrefix = `${LEDGER_CONTEXT_ROOT}/${this.ledgerDigest}/s/`;
    this.epochAuthorityPrefix = `${LEDGER_CONTEXT_ROOT}/${this.ledgerDigest}/a/`;
  }

  apiPath(suffix) {
    return `https://api.github.com/repos/${encodeURIComponent(this.repository.owner)}/${encodeURIComponent(this.repository.name)}${suffix}`;
  }

  async request(suffix, { method = 'GET', body, allow404 = false } = {}) {
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
        signal: globalThis.AbortSignal.timeout(30_000)
      });
    } catch (error) {
      throw new Error('cloud_state_github_request_failed', { cause: error });
    }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw responseError(response.status);
    return response.status === 204 ? null : response.json();
  }

  async graphqlRequest(query, variables) {
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
    if (!response.ok) throw responseError(response.status);
    const payload = await response.json();
    if (!payload || typeof payload !== 'object' || (Array.isArray(payload.errors) && payload.errors.length > 0)) {
      throw new Error('cloud_state_history_query_failed');
    }
    return payload.data;
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
    this.ledgerRootVerified = true;
  }

  epochRegistrationContext(epoch) {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('cloud_state_epoch_invalid');
    return `${this.epochRegistrationPrefix}${epoch}`;
  }

  epochSealContext(epoch) {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('cloud_state_epoch_invalid');
    return `${this.epochSealPrefix}${epoch}`;
  }

  epochAuthorityContext(epoch, generation) {
    if (epochForGeneration(generation) !== epoch) throw new Error('cloud_state_epoch_generation_mismatch');
    return `${this.epochAuthorityPrefix}${epoch}/g/${generation}`;
  }

  registrationDescription(anchorSha, baseGeneration, startGeneration) {
    if (!Number.isSafeInteger(baseGeneration) || baseGeneration < 0 ||
        !Number.isSafeInteger(startGeneration) || startGeneration !== baseGeneration + 1) {
      throw new Error('cloud_state_epoch_registration_invalid');
    }
    return `a=${assertSha(anchorSha)};b=${baseGeneration};s=${startGeneration}`;
  }

  sealDescription(stateSha, generation) {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('cloud_state_generation_invalid');
    return `s=${assertSha(stateSha)};g=${generation}`;
  }

  authorityDescription(stateSha, parentSha) {
    return `s=${assertSha(stateSha)};p=${assertSha(parentSha)}`;
  }

  parseRootStatus(status) {
    const context = typeof status?.context === 'string' ? status.context.toLowerCase() : '';
    const registrationPrefix = this.epochRegistrationPrefix.toLowerCase();
    const sealPrefix = this.epochSealPrefix.toLowerCase();
    let kind;
    let epochText;
    if (context.startsWith(registrationPrefix)) {
      kind = 'registration';
      epochText = context.slice(registrationPrefix.length);
    } else if (context.startsWith(sealPrefix)) {
      kind = 'seal';
      epochText = context.slice(sealPrefix.length);
    } else {
      const lanePrefix = `${LEDGER_CONTEXT_ROOT}/${this.ledgerDigest}/`.toLowerCase();
      if (context.startsWith(lanePrefix)) throw new Error('cloud_state_epoch_index_invalid');
      return null;
    }
    if (!/^(?:0|[1-9][0-9]*)$/.test(epochText)) throw new Error('cloud_state_epoch_index_invalid');
    const epoch = Number(epochText);
    if (!Number.isSafeInteger(epoch)) throw new Error('cloud_state_epoch_index_invalid');
    if (status.state !== 'success' || (status.target_url !== null && status.target_url !== undefined) ||
        typeof status.description !== 'string') {
      throw new Error('cloud_state_epoch_index_invalid');
    }
    if (kind === 'registration') {
      const match = /^a=([a-f0-9]{40});b=(0|[1-9][0-9]*);s=([1-9][0-9]*)$/i.exec(status.description);
      if (!match) throw new Error('cloud_state_epoch_registration_invalid');
      const anchorSha = assertSha(match[1], 'cloud_state_epoch_registration_invalid');
      const baseGeneration = Number(match[2]);
      const startGeneration = Number(match[3]);
      if (!Number.isSafeInteger(baseGeneration) || !Number.isSafeInteger(startGeneration) ||
          startGeneration !== baseGeneration + 1 || epochForGeneration(startGeneration) !== epoch) {
        throw new Error('cloud_state_epoch_registration_invalid');
      }
      return { kind, epoch, anchorSha, baseGeneration, startGeneration };
    }
    const match = /^s=([a-f0-9]{40});g=([1-9][0-9]*)$/i.exec(status.description);
    if (!match) throw new Error('cloud_state_epoch_seal_invalid');
    const stateSha = assertSha(match[1], 'cloud_state_epoch_seal_invalid');
    const generation = Number(match[2]);
    if (!Number.isSafeInteger(generation) || epochForGeneration(generation) !== epoch ||
        generation !== epochEndGeneration(epoch)) {
      throw new Error('cloud_state_epoch_seal_invalid');
    }
    return { kind, epoch, stateSha, generation };
  }

  async readRootEvidence() {
    await this.verifyLedgerRoot();
    const registrations = new Map();
    const seals = new Map();
    let completed = false;
    for (let page = 1; page <= ROOT_STATUS_MAX_PAGES; page += 1) {
      const statuses = await this.request(`/commits/${LEDGER_ROOT_SHA}/statuses?per_page=${STATUS_PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(statuses)) throw new Error('cloud_state_epoch_index_invalid');
      for (const status of statuses) {
        const record = this.parseRootStatus(status);
        if (!record) continue;
        const target = record.kind === 'registration' ? registrations : seals;
        const previous = target.get(record.epoch);
        if (previous && JSON.stringify(previous) !== JSON.stringify(record)) {
          throw new Error(record.kind === 'registration' ? 'cloud_state_epoch_registration_conflict' : 'cloud_state_epoch_seal_conflict');
        }
        target.set(record.epoch, record);
      }
      if (statuses.length < STATUS_PAGE_SIZE) {
        completed = true;
        break;
      }
    }
    if (!completed) throw new Error('cloud_state_epoch_index_limit');

    const ordered = [...registrations.values()].sort((a, b) => a.epoch - b.epoch);
    if (ordered.length === 0) {
      if (seals.size) throw new Error('cloud_state_epoch_index_invalid');
      return { registrations: ordered, registrationByEpoch: registrations, seals };
    }
    for (let index = 0; index < ordered.length; index += 1) {
      const current = ordered[index];
      if (current.startGeneration !== current.baseGeneration + 1 ||
          epochForGeneration(current.startGeneration) !== current.epoch) {
        throw new Error('cloud_state_epoch_registration_invalid');
      }
      if (index > 0) {
        const previous = ordered[index - 1];
        const seal = seals.get(previous.epoch);
        if (!seal || current.epoch !== previous.epoch + 1 ||
            current.anchorSha !== seal.stateSha ||
            current.baseGeneration !== seal.generation ||
            current.startGeneration !== seal.generation + 1) {
          throw new Error('cloud_state_epoch_chain_invalid');
        }
      }
    }
    for (const seal of seals.values()) {
      if (!registrations.has(seal.epoch)) throw new Error('cloud_state_epoch_seal_invalid');
    }
    for (let index = 0; index < ordered.length - 1; index += 1) {
      if (!seals.has(ordered[index].epoch)) throw new Error('cloud_state_epoch_chain_invalid');
    }
    return { registrations: ordered, registrationByEpoch: registrations, seals };
  }

  parseEpochAuthority(status, registration) {
    const context = typeof status?.context === 'string' ? status.context.toLowerCase() : '';
    const prefix = `${this.epochAuthorityPrefix}${registration.epoch}/g/`.toLowerCase();
    if (!context.startsWith(prefix)) {
      const laneAuthorityPrefix = this.epochAuthorityPrefix.toLowerCase();
      if (context.startsWith(laneAuthorityPrefix)) throw new Error('cloud_state_epoch_authority_invalid');
      return null;
    }
    const generationText = context.slice(prefix.length);
    if (!/^[1-9][0-9]*$/.test(generationText)) throw new Error('cloud_state_epoch_authority_invalid');
    const generation = Number(generationText);
    if (!Number.isSafeInteger(generation) || epochForGeneration(generation) !== registration.epoch ||
        generation < registration.startGeneration || generation > epochEndGeneration(registration.epoch)) {
      throw new Error('cloud_state_epoch_authority_invalid');
    }
    if (status.state !== 'success' || (status.target_url !== null && status.target_url !== undefined) ||
        typeof status.description !== 'string') {
      throw new Error('cloud_state_epoch_authority_invalid');
    }
    const match = /^s=([a-f0-9]{40});p=([a-f0-9]{40})$/i.exec(status.description);
    if (!match) throw new Error('cloud_state_epoch_authority_invalid');
    return {
      generation,
      stateSha: assertSha(match[1], 'cloud_state_epoch_authority_invalid'),
      parentSha: assertSha(match[2], 'cloud_state_epoch_authority_invalid')
    };
  }

  async readEpochAuthorities(registration) {
    const byGeneration = new Map();
    let completed = false;
    for (let page = 1; page <= EPOCH_STATUS_MAX_PAGES; page += 1) {
      const statuses = await this.request(`/commits/${registration.anchorSha}/statuses?per_page=${STATUS_PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(statuses)) throw new Error('cloud_state_epoch_authority_invalid');
      for (const status of statuses) {
        const record = this.parseEpochAuthority(status, registration);
        if (!record) continue;
        const previous = byGeneration.get(record.generation);
        if (previous && (previous.stateSha !== record.stateSha || previous.parentSha !== record.parentSha)) {
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

  async readEpochEvidence() {
    const root = await this.readRootEvidence();
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
      authority = { generation: previousSeal.generation, stateSha: previousSeal.stateSha, parentSha: null, sealed: true };
      authorityRegistration = previousRegistration;
    }
    const activeSeal = root.seals.get(activeRegistration.epoch) ?? null;
    if (activeSeal) {
      const latest = activeAuthorities.at(-1);
      if (!latest || latest.generation !== activeSeal.generation || latest.stateSha !== activeSeal.stateSha) {
        throw new Error('cloud_state_epoch_seal_mismatch');
      }
    }
    return { ...root, activeRegistration, activeAuthorities, authority, authorityRegistration };
  }

  async appendRootStatus(context, description) {
    let postError = null;
    try {
      await this.request(`/statuses/${LEDGER_ROOT_SHA}`, {
        method: 'POST',
        body: { state: 'success', context, description }
      });
    } catch (error) {
      postError = error;
    }
    return postError;
  }

  async ensureEpochRegistration(epoch, anchorSha, baseGeneration, startGeneration, observedRoot = null) {
    const desired = {
      kind: 'registration',
      epoch,
      anchorSha: assertSha(anchorSha),
      baseGeneration,
      startGeneration
    };
    const root = observedRoot ?? await this.readRootEvidence();
    const existing = root.registrationByEpoch.get(epoch);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(desired)) return { root, registration: existing };
      throw new Error('cloud_state_epoch_registration_conflict');
    }
    const postError = await this.appendRootStatus(
      this.epochRegistrationContext(epoch),
      this.registrationDescription(anchorSha, baseGeneration, startGeneration)
    );
    const after = await this.readRootEvidence();
    const observed = after.registrationByEpoch.get(epoch);
    if (observed && JSON.stringify(observed) === JSON.stringify(desired)) return { root: after, registration: observed };
    if (observed) throw new Error('cloud_state_epoch_registration_conflict', { cause: postError ?? undefined });
    if (postError) throw postError;
    throw new Error('cloud_state_epoch_registration_append_failed');
  }

  async ensureEpochSeal(registration, authority, observedRoot = null) {
    if (!authority || authority.generation !== epochEndGeneration(registration.epoch) ||
        epochForGeneration(authority.generation) !== registration.epoch) {
      throw new Error('cloud_state_epoch_seal_invalid');
    }
    const desired = {
      kind: 'seal',
      epoch: registration.epoch,
      stateSha: assertSha(authority.stateSha),
      generation: authority.generation
    };
    const root = observedRoot ?? await this.readRootEvidence();
    const existing = root.seals.get(registration.epoch);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(desired)) return root;
      throw new Error('cloud_state_epoch_seal_conflict');
    }
    const postError = await this.appendRootStatus(
      this.epochSealContext(registration.epoch),
      this.sealDescription(authority.stateSha, authority.generation)
    );
    const after = await this.readRootEvidence();
    const observed = after.seals.get(registration.epoch);
    if (observed && JSON.stringify(observed) === JSON.stringify(desired)) return after;
    if (observed) throw new Error('cloud_state_epoch_seal_conflict', { cause: postError ?? undefined });
    if (postError) throw postError;
    throw new Error('cloud_state_epoch_seal_append_failed');
  }

  async appendEpochAuthorityAfterCas(registration, generation, stateSha, parentSha, preCasAuthorities) {
    const desired = {
      generation,
      stateSha: assertSha(stateSha),
      parentSha: assertSha(parentSha)
    };
    if (epochForGeneration(generation) !== registration.epoch) throw new Error('cloud_state_epoch_generation_mismatch');
    if (!Array.isArray(preCasAuthorities)) throw new Error('cloud_state_epoch_authority_invalid');
    if (preCasAuthorities.some((record) => record.generation === generation)) {
      throw new Error('cloud_state_epoch_authority_conflict');
    }
    let postError = null;
    try {
      await this.request(`/statuses/${registration.anchorSha}`, {
        method: 'POST',
        body: {
          state: 'success',
          context: this.epochAuthorityContext(registration.epoch, generation),
          description: this.authorityDescription(stateSha, parentSha)
        }
      });
    } catch (error) {
      postError = error;
    }
    const after = await this.readEpochAuthorities(registration);
    const observed = after.find((record) => record.generation === generation);
    if (observed?.stateSha === desired.stateSha && observed?.parentSha === desired.parentSha) return after;
    if (observed) throw new Error('cloud_state_epoch_authority_conflict', { cause: postError ?? undefined });
    if (postError) throw postError;
    throw new Error('cloud_state_epoch_authority_append_failed');
  }

  async validateLegacyMigrationHead(stateSha, stateEnvelope) {
    if (stateEnvelope.version !== 1) throw new Error('cloud_state_legacy_history_invalid');
    const commit = await this.readCommit(stateSha);
    if (commit.parents.length !== 1) throw new Error('cloud_state_history_fork');
  }

  async validateLineageAnchor(stateEnvelope) {
    const anchorSha = assertSha(stateEnvelope.lineageBaseSha, 'cloud_state_lineage_anchor_invalid');
    const anchorGeneration = stateEnvelope.lineageBaseGeneration;
    if (!Number.isInteger(anchorGeneration) || anchorGeneration < 0 || anchorGeneration >= stateEnvelope.generation) {
      throw new Error('cloud_state_lineage_anchor_invalid');
    }
    if (anchorGeneration === 0) {
      const currentBaseSha = await this.baseBranchSha();
      const relation = await this.compareCommits(anchorSha, currentBaseSha);
      if (!['identical', 'ahead'].includes(relation)) throw new Error('cloud_state_bootstrap_ancestry_invalid');
      return { anchorSha, anchorGeneration };
    }
    const anchorEnvelope = await this.readEnvelopeAt(anchorSha);
    if (anchorEnvelope.version !== 1 || anchorEnvelope.generation !== anchorGeneration) {
      throw new Error('cloud_state_lineage_anchor_invalid');
    }
    await this.validateLegacyMigrationHead(anchorSha, anchorEnvelope);
    return { anchorSha, anchorGeneration };
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
    if (this.validatedLineageHeads.has(authority.stateSha)) return;
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
    await this.validateLineageAnchor(stateEnvelope);

    const authorityByGeneration = new Map(authorities.map((record) => [record.generation, record]));
    let expectedSha = authority.stateSha;
    let expectedGeneration = authority.generation;
    let after = null;
    const seenCursors = new Set();
    let done = false;

    for (let page = 1; page <= HISTORY_MAX_PAGES && !done; page += 1) {
      const data = await this.graphqlRequest(HISTORY_QUERY, {
        owner: this.repository.owner,
        name: this.repository.name,
        oid: authority.stateSha,
        path: this.statePath,
        first: HISTORY_PAGE_SIZE,
        after
      });
      const history = data?.repository?.object?.history;
      if (!history || !Array.isArray(history.nodes) || !history.pageInfo || history.nodes.length < 1) {
        throw new Error('cloud_state_history_query_invalid');
      }
      for (const node of history.nodes) {
        if (done) break;
        const oid = assertSha(node?.oid, 'cloud_state_history_query_invalid');
        if (oid !== expectedSha) throw new Error('cloud_state_history_fork');
        const parents = node?.parents;
        if (!parents || parents.totalCount !== 1 || !Array.isArray(parents.nodes) || parents.nodes.length !== 1) {
          throw new Error('cloud_state_history_fork');
        }
        const parentSha = assertSha(parents.nodes[0]?.oid, 'cloud_state_parent_invalid');
        const envelope = this.parseHistoryBlob(node?.file?.object);
        if (envelope.version !== 2 || envelope.generation !== expectedGeneration) {
          throw new Error('cloud_state_generation_discontinuity');
        }
        if (assertSha(envelope.lineageBaseSha, 'cloud_state_lineage_anchor_invalid') !== firstRegistration.anchorSha ||
            envelope.lineageBaseGeneration !== firstRegistration.baseGeneration) {
          throw new Error('cloud_state_lineage_anchor_mismatch');
        }
        const authorityRecord = authorityByGeneration.get(expectedGeneration);
        if (!authorityRecord || authorityRecord.stateSha !== oid || authorityRecord.parentSha !== parentSha) {
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
      if (done) break;
      if (history.pageInfo.hasNextPage !== true || typeof history.pageInfo.endCursor !== 'string' || !history.pageInfo.endCursor) {
        throw new Error('cloud_state_history_incomplete');
      }
      if (seenCursors.has(history.pageInfo.endCursor)) throw new Error('cloud_state_history_query_invalid');
      seenCursors.add(history.pageInfo.endCursor);
      after = history.pageInfo.endCursor;
    }
    if (!done) throw new Error('cloud_state_history_page_limit');
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
    const [refs, evidence] = await Promise.all([this.readRefs(), this.readEpochEvidence()]);
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

    if (evidence.authorityRegistration === evidence.activeRegistration && evidence.activeAuthorities.length > 0) {
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
    }

    if (!stateSha) {
      if (!repair) throw new Error('cloud_state_rollback');
      const repaired = await this.repairAllRefs(refs, authority.stateSha);
      return this.snapshotFrom(repaired.stateSha, repaired.checkpointSha, repaired.witnessSha, authorityEnvelope, authority);
    }
    if (stateSha !== authority.stateSha) {
      const relation = await this.relationToAuthority(stateSha, authority.stateSha);
      if (relation === 'behind') {
        if (!repair) throw new Error('cloud_state_rollback');
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
      const repaired = await this.repairAllRefs(refs, authority.stateSha);
      return this.snapshotFrom(repaired.stateSha, repaired.checkpointSha, repaired.witnessSha, authorityEnvelope, authority);
    }
    return this.snapshotFrom(stateSha, checkpointSha, witnessSha, authorityEnvelope, authority);
  }

  async advanceStateRefStrict(expectedSha, targetSha) {
    if (expectedSha) {
      await this.request(`/git/refs/tags/${encodeURIComponent(this.tag)}`, {
        method: 'PATCH',
        body: { sha: targetSha, force: false }
      });
    } else {
      await this.request('/git/refs', {
        method: 'POST',
        body: { ref: `refs/tags/${this.tag}`, sha: targetSha }
      });
    }
    const observed = await this.refSha(`tags/${encodeURIComponent(this.tag)}`);
    if (observed !== targetSha) throw new Error('cloud_state_state_cas_unproven');
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

  async writeSnapshot(state, snapshot) {
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

    const preCasAuthorities = await this.readEpochAuthorities(registration);
    const expectedPreviousGeneration = generation - 1;
    if (preCasAuthorities.some((record) => record.generation >= generation)) throw new Error('cloud_state_epoch_authority_conflict');
    if (generation === registration.startGeneration) {
      if (registration.anchorSha !== parentSha || registration.baseGeneration !== expectedPreviousGeneration) {
        throw new Error('cloud_state_epoch_registration_conflict');
      }
      if (preCasAuthorities.length !== 0) throw new Error('cloud_state_epoch_authority_conflict');
    } else {
      const previous = preCasAuthorities.at(-1);
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

    try {
      await this.advanceStateRefStrict(expectedStateSha, commitSha);
    } catch (error) {
      throw new Error('cloud_state_state_cas_unproven', { cause: error });
    }

    let authorityError = null;
    let nextAuthorities = null;
    try {
      nextAuthorities = await this.appendEpochAuthorityAfterCas(
        registration,
        generation,
        commitSha,
        parentSha,
        preCasAuthorities
      );
    } catch (error) {
      authorityError = error;
    }
    if (authorityError) throw new Error('cloud_state_partial_publication', { cause: authorityError });

    const authority = nextAuthorities.at(-1);
    await this.validateEpochLineage(registration, authority, nextAuthorities, root);

    let checkpointError = null;
    let witnessError = null;
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
    throw new Error('cloud_state_partial_publication', { cause: checkpointError ?? witnessError ?? undefined });
  }

  async load() {
    return (await this.readSnapshot()).state;
  }

  async save() {
    throw new Error('cloud_state_direct_save_forbidden');
  }

  async mutateInternal(mutator, { requireLease }) {
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
    await this.writeSnapshot(data, snapshot);
    return output;
  }

  async mutate(mutator) {
    return this.mutateInternal(mutator, { requireLease: true });
  }

  async ownerIdentity() {
    return this.ownerId;
  }

  async lockOwnerIsAbandoned(metadata) {
    const createdAt = Date.parse(metadata?.createdAt ?? '');
    if (!Number.isFinite(createdAt)) return false;
    if (metadata?.ownerIdentity === this.ownerId) return false;
    return this.now() - createdAt >= this.leaseTtlMs;
  }

  async claimGlobalLease() {
    const lease = {
      leaseId: randomUUID(),
      ownerId: this.ownerId,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + this.leaseTtlMs).toISOString()
    };
    await this.mutateInternal((data) => {
      const existing = data.cloudExecutionLease;
      const existingExpiry = Date.parse(existing?.expiresAt ?? '');
      if (existing && Number.isFinite(existingExpiry) && existingExpiry > this.now()) {
        throw new Error('cloud_global_lease_busy');
      }
      data.cloudExecutionLease = lease;
      return lease;
    }, { requireLease: false });
    this.activeGlobalLeaseId = lease.leaseId;
    return lease;
  }

  async releaseGlobalLease(leaseId) {
    const released = await this.mutateInternal((data) => {
      if (data.cloudExecutionLease?.leaseId !== leaseId || data.cloudExecutionLease?.ownerId !== this.ownerId) return false;
      data.cloudExecutionLease = null;
      return true;
    }, { requireLease: false });
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
