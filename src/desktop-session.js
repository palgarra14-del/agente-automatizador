import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  desktopActionRequiresApproval,
  desktopActionRisk,
  desktopRequestFingerprint,
  normalizeDesktopRequest
} from './desktop-bridge.js';

const terminalStatuses = new Set(['completed', 'blocked', 'failed', 'cancelled']);
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxSessionBytes = 256 * 1024;

function boundedText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`desktop_session_${label}_invalid`);
  return value.trim();
}

function positiveInteger(value, label, { min = 1, max = 100 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`desktop_session_${label}_invalid`);
  return value;
}

function safeSessionId(id) {
  if (typeof id !== 'string' || !sessionIdPattern.test(id)) throw new Error('desktop_session_id_invalid');
  return id;
}

async function ensureDirectory(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(path, { mode: 0o700 });
    info = await lstat(path);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('desktop_session_store_directory_invalid');
  await chmod(path, 0o700);
}

export class FileDesktopSessionStore {
  constructor({ home = homedir() } = {}) {
    this.home = resolve(home);
    this.base = resolve(this.home, '.engineering-orchestrator');
    this.root = resolve(this.base, 'desktop-sessions');
  }

  async ensure() {
    const homeInfo = await lstat(this.home);
    if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) throw new Error('desktop_session_store_home_invalid');
    await ensureDirectory(this.base);
    await ensureDirectory(this.root);
  }

  path(id) {
    return resolve(this.root, `${safeSessionId(id)}.json`);
  }

  async save(session) {
    await this.ensure();
    const file = this.path(session.id);
    const payload = `${JSON.stringify(session, null, 2)}\n`;
    if (Buffer.byteLength(payload) > maxSessionBytes) throw new Error('desktop_session_store_record_too_large');
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, payload, { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
      await chmod(file, 0o600);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return session;
  }

  async load(id) {
    await this.ensure();
    const file = this.path(id);
    let info;
    try {
      info = await lstat(file);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1 || info.size > maxSessionBytes) {
      throw new Error('desktop_session_store_record_invalid');
    }
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (parsed?.id !== id) throw new Error('desktop_session_store_id_mismatch');
    return parsed;
  }
}

export class MemoryDesktopSessionStore {
  constructor() { this.sessions = new Map(); }
  async save(session) {
    const copy = structuredClone(session);
    this.sessions.set(session.id, copy);
    return structuredClone(copy);
  }
  async load(id) {
    const value = this.sessions.get(id);
    return value ? structuredClone(value) : null;
  }
}

function actionHistoryEntry(request, execution) {
  switch (request.action) {
    case 'window.focus':
      return { action: 'window.focus', outcome: `Focused process ${request.processId}.` };
    case 'input.click':
      return { action: 'input.click', outcome: `Clicked native desktop coordinate (${request.x}, ${request.y}).` };
    case 'input.keys':
      return { action: 'input.keys', outcome: `Sent ${request.keys.length} SendKeys characters to process ${request.processId}; key content not persisted.` };
    case 'url.open': {
      let target = 'requested URL';
      try {
        const parsed = new URL(request.url);
        target = `${parsed.origin}${parsed.pathname}`;
      } catch { /* request was validated earlier */ }
      return { action: 'url.open', outcome: `Opened ${target}; query and fragment not persisted.` };
    }
    case 'app.launch':
      return { action: 'app.launch', outcome: `Launched the requested application${execution?.evidence?.processId ? ` as process ${execution.evidence.processId}` : ''}; arguments not persisted.` };
    default:
      return { action: String(request.action), outcome: 'Action completed.' };
  }
}

function sessionView(session) {
  return structuredClone(session);
}

export class DesktopTaskSessionEngine {
  constructor({ store = new FileDesktopSessionStore(), bridge, planner, now = () => new Date().toISOString() } = {}) {
    if (!bridge || typeof bridge.execute !== 'function' || typeof bridge.plan !== 'function') throw new Error('desktop_session_bridge_required');
    if (!planner || typeof planner.plan !== 'function') throw new Error('desktop_session_planner_required');
    Object.assign(this, { store, bridge, planner, now });
  }

  async start(goal, { maxActions = 30 } = {}) {
    const timestamp = this.now();
    const session = {
      version: 1,
      id: randomUUID(),
      goal: boundedText(goal, 'goal', 2_000),
      status: 'running',
      maxActions: positiveInteger(maxActions, 'max_actions'),
      actionCount: 0,
      history: [],
      pendingAction: null,
      result: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.store.save(session);
    return sessionView(session);
  }

  async get(id) {
    const session = await this.store.load(safeSessionId(id));
    if (!session) throw new Error('desktop_session_not_found');
    return sessionView(session);
  }

  async fail(session, error) {
    session.status = 'failed';
    session.error = String(error?.message ?? error).slice(0, 1_000);
    session.updatedAt = this.now();
    await this.store.save(session);
    return sessionView(session);
  }

  async step(id, { approvedFingerprint = null } = {}) {
    const session = await this.store.load(safeSessionId(id));
    if (!session) throw new Error('desktop_session_not_found');
    if (terminalStatuses.has(session.status)) return sessionView(session);

    if (session.pendingAction) {
      const pending = session.pendingAction;
      if (pending.requiresApproval && approvedFingerprint !== pending.fingerprint) {
        if (approvedFingerprint) throw new Error('desktop_session_approval_mismatch');
        session.status = 'awaiting_approval';
        session.updatedAt = this.now();
        await this.store.save(session);
        return sessionView(session);
      }
      if (!pending.requiresApproval && approvedFingerprint) throw new Error('desktop_session_unexpected_approval');
      try {
        const execution = await this.bridge.execute(pending.request, {
          approvedFingerprint: pending.requiresApproval ? approvedFingerprint : null
        });
        session.history.push(actionHistoryEntry(pending.request, execution));
        session.history = session.history.slice(-20);
        session.pendingAction = null;
        session.actionCount += 1;
        session.status = 'running';
        session.updatedAt = this.now();
        await this.store.save(session);
      } catch (error) {
        return this.fail(session, error);
      }
    } else if (approvedFingerprint) {
      throw new Error('desktop_session_approval_without_pending_action');
    }

    let windows;
    let screen;
    let planned;
    try {
      windows = await this.bridge.execute({ action: 'window.list' });
      screen = await this.bridge.execute({ action: 'screen.capture' });
      planned = await this.planner.plan({
        goal: session.goal,
        windows: windows.evidence,
        screen: screen.evidence,
        history: session.history
      });
    } catch (error) {
      return this.fail(session, error);
    }

    if (planned.decision.status === 'done') {
      session.status = 'completed';
      session.result = {
        reason: planned.decision.reason,
        summary: planned.decision.summary,
        observation: planned.observation ?? null
      };
      session.updatedAt = this.now();
      await this.store.save(session);
      return sessionView(session);
    }

    if (planned.decision.status === 'blocked') {
      session.status = 'blocked';
      session.result = {
        reason: planned.decision.reason,
        request: planned.decision.request,
        observation: planned.observation ?? null
      };
      session.updatedAt = this.now();
      await this.store.save(session);
      return sessionView(session);
    }

    if (session.actionCount >= session.maxActions) {
      session.status = 'blocked';
      session.result = {
        reason: 'desktop_session_action_budget_exhausted',
        observation: planned.observation ?? null
      };
      session.updatedAt = this.now();
      await this.store.save(session);
      return sessionView(session);
    }

    const request = normalizeDesktopRequest(planned.decision.action);
    const actionPlan = this.bridge.plan(request);
    const fingerprint = desktopRequestFingerprint(request);
    if (fingerprint !== actionPlan.fingerprint) return this.fail(session, new Error('desktop_session_action_fingerprint_mismatch'));
    if (desktopActionRisk(request.action) !== actionPlan.risk || desktopActionRequiresApproval(request.action) !== actionPlan.requiresApproval) {
      return this.fail(session, new Error('desktop_session_action_policy_mismatch'));
    }
    session.pendingAction = {
      request,
      reason: planned.decision.reason,
      fingerprint,
      risk: actionPlan.risk,
      requiresApproval: actionPlan.requiresApproval,
      observation: planned.observation ?? null
    };
    session.status = actionPlan.requiresApproval ? 'awaiting_approval' : 'running';
    session.updatedAt = this.now();
    await this.store.save(session);
    return sessionView(session);
  }
}
