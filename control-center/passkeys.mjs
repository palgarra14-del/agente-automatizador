import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from '@simplewebauthn/server';

const FLOW_TTL_MS = 2 * 60 * 1000;
const MAX_FLOWS = 20;

function now() { return Date.now(); }

function pruneFlows(map) {
  const cutoff = now() - FLOW_TTL_MS;
  for (const [id, flow] of map) if (flow.createdAt < cutoff) map.delete(id);
  while (map.size > MAX_FLOWS) map.delete(map.keys().next().value);
}

function flowId() {
  return randomUUID();
}

export class PasskeyAuth {
  constructor({
    filePath,
    rpID = 'agente-automatizador.vercel.app',
    origin = 'https://agente-automatizador.vercel.app',
    rpName = 'Agent Control',
    userName = 'owner'
  }) {
    this.filePath = filePath;
    this.rpID = rpID;
    this.origin = origin;
    this.rpName = rpName;
    this.userName = userName;
    this.registrationFlows = new Map();
    this.authenticationFlows = new Map();
  }

  async readStore() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      return {
        version: 1,
        credentials: Array.isArray(parsed.credentials) ? parsed.credentials : []
      };
    } catch {
      return { version: 1, credentials: [] };
    }
  }

  async writeStore(store) {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await writeFile(this.filePath, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  }

  async status() {
    const store = await this.readStore();
    return {
      enabled: store.credentials.length > 0,
      count: store.credentials.length,
      rpID: this.rpID
    };
  }

  async registrationOptions() {
    const store = await this.readStore();
    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpID,
      userName: this.userName,
      userID: new TextEncoder().encode('agent-control-owner'),
      attestationType: 'none',
      excludeCredentials: store.credentials.map((credential) => ({
        id: credential.id,
        transports: credential.transports
      })),
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        userVerification: 'required'
      }
    });
    pruneFlows(this.registrationFlows);
    const id = flowId();
    this.registrationFlows.set(id, { challenge: options.challenge, createdAt: now() });
    return { flowId: id, options };
  }

  async verifyRegistration(flow, response) {
    pruneFlows(this.registrationFlows);
    const current = this.registrationFlows.get(String(flow || ''));
    this.registrationFlows.delete(String(flow || ''));
    if (!current) throw new Error('passkey_registration_expired');

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: current.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      requireUserVerification: true
    });
    if (!verification.verified || !verification.registrationInfo) throw new Error('passkey_registration_failed');

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const store = await this.readStore();
    const next = store.credentials.filter((item) => item.id !== credential.id);
    next.push({
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports || response?.response?.transports || [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      createdAt: new Date().toISOString()
    });
    await this.writeStore({ version: 1, credentials: next });
    return { verified: true, count: next.length };
  }

  async authenticationOptions() {
    const store = await this.readStore();
    if (!store.credentials.length) throw new Error('passkey_not_configured');
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      allowCredentials: store.credentials.map((credential) => ({
        id: credential.id,
        transports: credential.transports
      })),
      userVerification: 'required'
    });
    pruneFlows(this.authenticationFlows);
    const id = flowId();
    this.authenticationFlows.set(id, { challenge: options.challenge, createdAt: now() });
    return { flowId: id, options };
  }

  async verifyAuthentication(flow, response) {
    pruneFlows(this.authenticationFlows);
    const current = this.authenticationFlows.get(String(flow || ''));
    this.authenticationFlows.delete(String(flow || ''));
    if (!current) throw new Error('passkey_authentication_expired');

    const store = await this.readStore();
    const saved = store.credentials.find((credential) => credential.id === response?.id);
    if (!saved) throw new Error('passkey_unknown_credential');

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: current.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      credential: {
        id: saved.id,
        publicKey: Buffer.from(saved.publicKey, 'base64url'),
        counter: Number(saved.counter || 0),
        transports: saved.transports || []
      },
      requireUserVerification: true
    });
    if (!verification.verified) throw new Error('passkey_authentication_failed');

    saved.counter = verification.authenticationInfo.newCounter;
    saved.lastUsedAt = new Date().toISOString();
    await this.writeStore(store);
    return { verified: true };
  }
}
