import { createHash, randomUUID } from 'node:crypto';
import { JsonStore } from './core.js';

const DEFAULT_TAG = 'agent-cloud-state-v1';
const DEFAULT_PATH = '.agent/cloud-state.json';
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_LEASE_TTL_MS = 20 * 60 * 1000;
const HISTORY_PAGE_SIZE = 100;
const STATUS_PAGE_SIZE = 100;
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
    this.ledgerContextPrefix = `${LEDGER_CONTEXT_ROOT}/${this.ledgerDigest}/g/`;
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

  ledgerContext(generation) {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('cloud_state_generation_invalid');
    return `${this.ledgerContextPrefix}${generation}`;
  }

  ledgerDescription(stateSha, parentSha) {
    return `s=${assertSha(stateSha)};p=${assertSha(parentSha)}`;
  }

  parseLedgerStatus(status) {
    const context = typeof status?.context === 'string' ? status.context.toLowerCase() : '';
    const prefix = this.ledgerContextPrefix.toLowerCase();
    if (!context.startsWith(prefix)) return null;
    const generationText = context.slice(prefix.length);
    if (!/^[1-9][0-9]*$/.test(generationText)) throw new Error('cloud_state_status_ledger_invalid');
    const generation = Number(generationText);
    if (!Number.isSafeInteger(generation)) throw new Error('cloud_state_status_ledger_invalid');
    if (status.state !== 'success' || (status.target_url !== null && status.target_url !== undefined) || typeof status.description !== 'string') {
      throw new Error('cloud_state_status_ledger_invalid');
    }
    const match = /^s=([a-f0-9]{40});p=([a-f0-9]{40})$/i.exec(status.description);
    if (!match) throw new Error('cloud_state_status_ledger_invalid');
    return {
      generation,
      stateSha: assertSha(match[1], 'cloud_state_status_ledger_invalid'),
      parentSha: assertSha(match[2], 'cloud_state_status_ledger_invalid')
    };
  }

  async readStatusLedger() {
    await this.verifyLedgerRoot();
    const byGeneration = new Map();
    let page = 1;
    while (true) {
      const statuses = await this.request(`/commits/${LEDGER_ROOT_SHA}/statuses?per_page=${STATUS_PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(statuses)) throw new Error('cloud_state_status_ledger_invalid');
      for (const status of statuses) {
        const record = this.parseLedgerStatus(status);
        if (!record) continue;
        const previous = byGeneration.get(record.generation);
        if (previous && (previous.stateSha !== record.stateSha || previous.parentSha !== record.parentSha)) {
          throw new Error('cloud_state_status_ledger_conflict');
        }
        byGeneration.set(record.generation, record);
      }
      if (statuses.length < STATUS_PAGE_SIZE) break;
      page += 1;
    }
    const records = [...byGeneration.values()].sort((a, b) => a.generation - b.generation);
    for (let index = 1; index < records.length; index += 1) {
      const previous = records[index - 1];
      const current = records[index];
      if (current.generation !== previous.generation + 1 || current.parentSha !== previous.stateSha) {
        throw new Error('cloud_state_status_ledger_gap');
      }
    }
    return records;
  }

  async appendStatusRecord(generation, stateSha, parentSha, observedLedger = null) {
    const desired = {
      generation,
      stateSha: assertSha(stateSha),
      parentSha: assertSha(parentSha)
    };
    const before = observedLedger ?? await this.readStatusLedger();
    const existing = before.find((record) => record.generation === generation);
    if (existing) {
      if (existing.stateSha === desired.stateSha && existing.parentSha === desired.parentSha) return;
      throw new Error('cloud_state_status_ledger_conflict');
    }
    if (before.length > 0) {
      const latest = before.at(-1);
      if (generation !== latest.generation + 1 || parentSha !== latest.stateSha) {
        throw new Error('cloud_state_status_ledger_gap');
      }
    }

    let postError = null;
    try {
      await this.request(`/statuses/${LEDGER_ROOT_SHA}`, {
        method: 'POST',
        body: {
          state: 'success',
          context: this.ledgerContext(generation),
          description: this.ledgerDescription(stateSha, parentSha)
        }
      });
    } catch (error) {
      postError = error;
    }
    const after = await this.readStatusLedger();
    const observed = after.find((record) => record.generation === generation);
    if (observed?.stateSha === desired.stateSha && observed?.parentSha === desired.parentSha) return;
    if (observed) throw new Error('cloud_state_status_ledger_conflict', { cause: postError ?? undefined });
    if (postError) throw postError;
    throw new Error('cloud_state_status_append_failed');
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

  async validateCompleteV2Lineage(stateSha, stateEnvelope, ledger) {
    if (this.validatedLineageHeads.has(stateSha)) return;
    if (!Array.isArray(ledger) || ledger.length < 1) throw new Error('cloud_state_status_ledger_missing');
    const { anchorSha, anchorGeneration } = await this.validateLineageAnchor(stateEnvelope);
    if (ledger[0].generation !== anchorGeneration + 1 || ledger[0].parentSha !== anchorSha) {
      throw new Error('cloud_state_status_ledger_gap');
    }
    const latest = ledger.at(-1);
    if (latest.generation !== stateEnvelope.generation || latest.stateSha !== stateSha) {
      throw new Error('cloud_state_status_ledger_mismatch');
    }
    const ledgerByGeneration = new Map(ledger.map((record) => [record.generation, record]));
    let expectedSha = stateSha;
    let expectedGeneration = stateEnvelope.generation;
    let after = null;
    const seenCursors = new Set();
    let done = false;

    while (!done) {
      const data = await this.graphqlRequest(HISTORY_QUERY, {
        owner: this.repository.owner,
        name: this.repository.name,
        oid: stateSha,
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
        if (envelope.version !== 2) throw new Error('cloud_state_legacy_after_migration');
        if (envelope.generation !== expectedGeneration) throw new Error('cloud_state_generation_discontinuity');
        if (assertSha(envelope.lineageBaseSha, 'cloud_state_lineage_anchor_invalid') !== anchorSha ||
            envelope.lineageBaseGeneration !== anchorGeneration) {
          throw new Error('cloud_state_lineage_anchor_mismatch');
        }
        const ledgerRecord = ledgerByGeneration.get(expectedGeneration);
        if (!ledgerRecord || ledgerRecord.stateSha !== oid || ledgerRecord.parentSha !== parentSha) {
          throw new Error('cloud_state_status_ledger_mismatch');
        }

        if (expectedGeneration === anchorGeneration + 1) {
          if (parentSha !== anchorSha) throw new Error('cloud_state_history_invalid');
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

    this.validatedLineageHeads.add(stateSha);
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

  async validateFirstV2Candidate(stateSha, stateEnvelope) {
    if (stateEnvelope.version !== 2) throw new Error('cloud_state_v2_required');
    const { anchorSha, anchorGeneration } = await this.validateLineageAnchor(stateEnvelope);
    if (stateEnvelope.generation !== anchorGeneration + 1) throw new Error('cloud_state_generation_discontinuity');
    const commit = await this.readCommit(stateSha);
    if (commit.parents.length !== 1 || assertSha(commit.parents[0]?.sha, 'cloud_state_parent_invalid') !== anchorSha) {
      throw new Error('cloud_state_history_fork');
    }
    return { anchorSha, anchorGeneration };
  }

  async recoverFirstStatus(refs, stateSha, stateEnvelope) {
    if (refs.checkpointSha || refs.witnessSha) throw new Error('cloud_state_status_ledger_missing');
    const { anchorSha } = await this.validateFirstV2Candidate(stateSha, stateEnvelope);
    const currentLedger = await this.readStatusLedger();
    if (currentLedger.length !== 0) throw new Error('cloud_state_status_ledger_conflict');
    const before = await this.readRefs();
    if (before.stateSha !== refs.stateSha || before.checkpointSha !== refs.checkpointSha || before.witnessSha !== refs.witnessSha) {
      throw new Error('cloud_state_conflict');
    }
    await this.appendStatusRecord(stateEnvelope.generation, stateSha, anchorSha, currentLedger);
    const ledger = await this.readStatusLedger();
    await this.validateCompleteV2Lineage(stateSha, stateEnvelope, ledger);
    await this.repairAllRefs(before, stateSha);
    return this.snapshotFrom(stateSha, stateSha, stateSha, stateEnvelope, ledger.at(-1));
  }

  async recoverStateAhead(refs, authority, authorityEnvelope, stateSha, stateEnvelope, ledger) {
    if (stateEnvelope.version !== 2 || stateEnvelope.generation !== authority.generation + 1) {
      throw new Error('cloud_state_status_ledger_missing');
    }
    await this.validateV2Edge(authority.stateSha, authorityEnvelope, stateSha, stateEnvelope);
    const before = await this.readRefs();
    if (before.stateSha !== refs.stateSha || before.checkpointSha !== refs.checkpointSha || before.witnessSha !== refs.witnessSha) {
      throw new Error('cloud_state_conflict');
    }
    const refreshedLedger = await this.readStatusLedger();
    const refreshedAuthority = refreshedLedger.at(-1);
    if (!refreshedAuthority || refreshedAuthority.generation !== authority.generation || refreshedAuthority.stateSha !== authority.stateSha) {
      throw new Error('cloud_state_status_ledger_conflict');
    }
    await this.appendStatusRecord(stateEnvelope.generation, stateSha, authority.stateSha, refreshedLedger);
    const nextLedger = await this.readStatusLedger();
    await this.validateCompleteV2Lineage(stateSha, stateEnvelope, nextLedger);
    await this.repairAllRefs(before, stateSha);
    return this.snapshotFrom(stateSha, stateSha, stateSha, stateEnvelope, nextLedger.at(-1));
  }

  async readSnapshot({ repair = false } = {}) {
    const [refs, ledger] = await Promise.all([this.readRefs(), this.readStatusLedger()]);
    const { stateSha, checkpointSha, witnessSha } = refs;

    if (ledger.length === 0) {
      if (!stateSha && !checkpointSha && !witnessSha) return this.snapshotFrom(null, null, null, null, null);
      if (!stateSha) throw new Error('cloud_state_partial_publication');
      const stateEnvelope = await this.readEnvelopeAt(stateSha);
      if (stateEnvelope.version === 1) {
        if (checkpointSha || witnessSha) throw new Error('cloud_state_legacy_after_migration');
        return this.snapshotFrom(stateSha, null, null, stateEnvelope, null);
      }
      if (!repair) throw new Error('cloud_state_status_ledger_missing');
      return this.recoverFirstStatus(refs, stateSha, stateEnvelope);
    }

    const authority = ledger.at(-1);
    const authorityEnvelope = await this.readEnvelopeAt(authority.stateSha);
    if (authorityEnvelope.version !== 2 || authorityEnvelope.generation !== authority.generation) {
      throw new Error('cloud_state_status_ledger_mismatch');
    }
    await this.validateCompleteV2Lineage(authority.stateSha, authorityEnvelope, ledger);

    if (!stateSha) {
      if (!repair) throw new Error('cloud_state_rollback');
      const repaired = await this.repairAllRefs(refs, authority.stateSha);
      return this.snapshotFrom(repaired.stateSha, repaired.checkpointSha, repaired.witnessSha, authorityEnvelope, authority);
    }

    if (stateSha !== authority.stateSha) {
      const stateEnvelope = await this.readEnvelopeAt(stateSha);
      const stateRelation = await this.relationToAuthority(stateSha, authority.stateSha);
      if (stateRelation === 'behind') {
        if (!repair) throw new Error('cloud_state_rollback');
        const repaired = await this.repairAllRefs(refs, authority.stateSha);
        return this.snapshotFrom(repaired.stateSha, repaired.checkpointSha, repaired.witnessSha, authorityEnvelope, authority);
      }
      if (stateRelation === 'ahead') {
        if (!repair) throw new Error('cloud_state_partial_publication');
        return this.recoverStateAhead(refs, authority, authorityEnvelope, stateSha, stateEnvelope, ledger);
      }
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
    const [current, ledger] = await Promise.all([this.readRefs(), this.readStatusLedger()]);
    if (current.stateSha !== expectedStateSha || current.checkpointSha !== expectedCheckpointSha || current.witnessSha !== expectedWitnessSha) {
      throw new Error('cloud_state_conflict');
    }

    let parentSha;
    let generation;
    let lineageBaseSha;
    let lineageBaseGeneration;
    if (!expectedStateSha) {
      if (expectedCheckpointSha || expectedWitnessSha || ledger.length > 0) throw new Error('cloud_state_snapshot_untrusted');
      parentSha = await this.baseBranchSha();
      generation = 1;
      lineageBaseSha = parentSha;
      lineageBaseGeneration = 0;
    } else {
      const parentEnvelope = await this.readEnvelopeAt(expectedStateSha);
      if (!expectedCheckpointSha && !expectedWitnessSha && parentEnvelope.version === 1) {
        if (ledger.length > 0) throw new Error('cloud_state_legacy_after_migration');
        await this.validateLegacyMigrationHead(expectedStateSha, parentEnvelope);
        lineageBaseSha = expectedStateSha;
        lineageBaseGeneration = parentEnvelope.generation;
      } else {
        const authority = ledger.at(-1);
        if (parentEnvelope.version !== 2 || !authority ||
            authority.stateSha !== expectedStateSha || authority.generation !== parentEnvelope.generation ||
            expectedCheckpointSha !== expectedStateSha || expectedWitnessSha !== expectedStateSha) {
          throw new Error('cloud_state_snapshot_untrusted');
        }
        await this.validateCompleteV2Lineage(expectedStateSha, parentEnvelope, ledger);
        lineageBaseSha = assertSha(parentEnvelope.lineageBaseSha, 'cloud_state_lineage_anchor_invalid');
        lineageBaseGeneration = parentEnvelope.lineageBaseGeneration;
      }
      parentSha = expectedStateSha;
      generation = parentEnvelope.generation + 1;
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

    await this.advanceRef(this.tag, expectedStateSha, commitSha);
    let ledgerError = null;
    try {
      await this.appendStatusRecord(generation, commitSha, parentSha, ledger);
    } catch (error) {
      ledgerError = error;
    }
    if (ledgerError) throw new Error('cloud_state_partial_publication', { cause: ledgerError });

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
    const [finalRefs, finalLedger] = await Promise.all([this.readRefs(), this.readStatusLedger()]);
    const finalAuthority = finalLedger.at(-1);
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
