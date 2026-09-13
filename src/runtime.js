import { runLocalCommand } from './service.js';

const digestPinnedImagePattern = /^[^\s@]+@sha256:[a-f0-9]{64}$/i;

function boundedText(value, label, max = 1_000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`${label}_invalid`);
  return value.trim();
}

function dockerEnvironment(environment = process.env) {
  const path = boundedText(String(environment.PATH ?? ''), 'docker_runtime_path', 16_384);
  return { PATH: path, CI: 'true' };
}

function configuredImages(projects) {
  const images = new Map();
  for (const project of projects ?? []) {
    const image = project?.execution?.image;
    if (typeof image !== 'string' || !image.trim()) continue;
    const normalized = boundedText(image, 'runtime_image', 512);
    const entry = images.get(normalized) ?? { image: normalized, projects: [], digestPinned: digestPinnedImagePattern.test(normalized) };
    if (typeof project.id === 'string' && project.id) entry.projects.push(project.id);
    images.set(normalized, entry);
  }
  return [...images.values()].map((entry) => ({ ...entry, projects: [...new Set(entry.projects)].sort() }));
}

async function dockerCommand(runner, dockerBinary, args, { environment, timeoutMs = 15_000, maxOutputBytes = 32_768 } = {}) {
  const result = await runner(dockerBinary, args, {
    cwd: process.cwd(),
    env: dockerEnvironment(environment),
    timeoutMs,
    maxOutputBytes
  });
  return { exitCode: result.exitCode ?? 1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

async function dockerProbe(runner, dockerBinary, environment) {
  const result = await dockerCommand(runner, dockerBinary, ['version', '--format', '{{.Server.Version}}'], { environment, timeoutMs: 10_000, maxOutputBytes: 8_192 });
  if (result.exitCode !== 0) return { available: false, reason: 'docker_runtime_unavailable' };
  return { available: true, version: result.stdout.trim() || 'available' };
}

async function inspectImage(runner, dockerBinary, image, environment) {
  const result = await dockerCommand(runner, dockerBinary, ['image', 'inspect', image, '--format', '{{.Id}}'], { environment, timeoutMs: 15_000, maxOutputBytes: 8_192 });
  if (result.exitCode === 0 && result.stdout.trim()) return { available: true, imageId: result.stdout.trim() };
  return { available: false };
}

export function isDigestPinnedRuntimeImage(image) {
  return typeof image === 'string' && digestPinnedImagePattern.test(image);
}

export async function projectRuntimeStatus(projects, {
  environment = process.env,
  commandRunner = runLocalCommand,
  dockerBinary = 'docker'
} = {}) {
  const images = configuredImages(projects);
  const probe = await dockerProbe(commandRunner, dockerBinary, environment);
  if (!probe.available) {
    return {
      docker: probe,
      ready: false,
      managedReady: false,
      images: images.map((entry) => ({ ...entry, available: false, action: 'unavailable' }))
    };
  }

  const status = [];
  for (const entry of images) {
    const inspected = await inspectImage(commandRunner, dockerBinary, entry.image, environment);
    status.push({ ...entry, ...inspected, action: inspected.available ? 'present' : 'missing' });
  }
  return {
    docker: probe,
    ready: status.every((entry) => entry.available),
    managedReady: status.filter((entry) => entry.digestPinned).every((entry) => entry.available),
    images: status
  };
}

export async function syncProjectRuntimes(projects, {
  environment = process.env,
  commandRunner = runLocalCommand,
  dockerBinary = 'docker',
  pullTimeoutMs = 180_000
} = {}) {
  if (!Number.isInteger(pullTimeoutMs) || pullTimeoutMs < 1_000 || pullTimeoutMs > 600_000) throw new Error('runtime_pull_timeout_invalid');
  const images = configuredImages(projects);
  const probe = await dockerProbe(commandRunner, dockerBinary, environment);
  if (!probe.available) throw new Error('docker_runtime_unavailable');

  const status = [];
  for (const entry of images) {
    const before = await inspectImage(commandRunner, dockerBinary, entry.image, environment);
    if (before.available) {
      status.push({ ...entry, ...before, action: 'present' });
      continue;
    }

    if (!entry.digestPinned) {
      status.push({ ...entry, available: false, action: 'manual', reason: 'runtime_image_missing_unmanaged' });
      continue;
    }

    const pulled = await dockerCommand(commandRunner, dockerBinary, ['pull', '--quiet', entry.image], {
      environment,
      timeoutMs: pullTimeoutMs,
      maxOutputBytes: 64 * 1024
    });
    if (pulled.exitCode !== 0) throw new Error(`runtime_image_pull_failed:${entry.image}`);

    const after = await inspectImage(commandRunner, dockerBinary, entry.image, environment);
    if (!after.available) throw new Error(`runtime_image_pull_verification_failed:${entry.image}`);
    status.push({ ...entry, ...after, action: 'pulled' });
  }

  return {
    docker: probe,
    ready: status.every((entry) => entry.available),
    managedReady: status.filter((entry) => entry.digestPinned).every((entry) => entry.available),
    images: status,
    missingUnmanaged: status.filter((entry) => !entry.available && !entry.digestPinned).map((entry) => entry.image)
  };
}
