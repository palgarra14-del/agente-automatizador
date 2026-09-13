import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { runLocalCommand } from './service.js';

const digestPinnedImagePattern = /^[^\s@]+@sha256:[a-f0-9]{64}$/i;
const literalImagePattern = /^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,511}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const runtimeRecipeLabel = 'engineering-orchestrator.recipe-sha256';

function boundedText(value, label, max = 1_000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`${label}_invalid`);
  return value.trim();
}

function safeRelativePath(value, label, { flat = false } = {}) {
  const path = boundedText(value, label, 240).replaceAll('\\', '/');
  if (path.startsWith('/') || path.endsWith('/') || path === '.' || path.includes('..') || /[\0\r\n]/.test(path)) throw new Error(`${label}_invalid`);
  if (!/^[A-Za-z0-9._/-]+$/.test(path)) throw new Error(`${label}_invalid`);
  if (flat && path.includes('/')) throw new Error(`${label}_must_be_flat`);
  return path;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function normalizeRuntimeImageConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('runtime_image_config_invalid');
  const keys = Object.keys(value);
  if (keys.some((key) => !['version', 'builds'].includes(key)) || value.version !== 1 || !Array.isArray(value.builds) || value.builds.length > 20) {
    throw new Error('runtime_image_config_invalid');
  }
  const seen = new Set();
  const builds = value.builds.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`runtime_image_build_${index}_invalid`);
    if (Object.keys(input).some((key) => !['image', 'context', 'files', 'fingerprint'].includes(key))) throw new Error(`runtime_image_build_${index}_invalid`);
    const image = boundedText(input.image, `runtime_image_build_${index}_image`, 512);
    if (!literalImagePattern.test(image) || digestPinnedImagePattern.test(image)) throw new Error(`runtime_image_build_${index}_image_invalid`);
    if (seen.has(image)) throw new Error('runtime_image_build_duplicate');
    seen.add(image);
    const context = safeRelativePath(input.context, `runtime_image_build_${index}_context`);
    if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 20) throw new Error(`runtime_image_build_${index}_files_invalid`);
    const fileNames = new Set();
    const files = input.files.map((file, fileIndex) => {
      if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).some((key) => !['path', 'sha256'].includes(key))) {
        throw new Error(`runtime_image_build_${index}_file_${fileIndex}_invalid`);
      }
      const path = safeRelativePath(file.path, `runtime_image_build_${index}_file_${fileIndex}_path`, { flat: true });
      const sha256 = boundedText(file.sha256, `runtime_image_build_${index}_file_${fileIndex}_sha256`, 64).toLowerCase();
      if (!sha256Pattern.test(sha256) || fileNames.has(path)) throw new Error(`runtime_image_build_${index}_file_${fileIndex}_invalid`);
      fileNames.add(path);
      return { path, sha256 };
    }).sort((a, b) => a.path.localeCompare(b.path));
    if (!fileNames.has('Dockerfile')) throw new Error(`runtime_image_build_${index}_requires_dockerfile`);
    const recipe = { image, context, files };
    const recipeFingerprint = fingerprint(recipe);
    if (input.fingerprint !== undefined && input.fingerprint !== recipeFingerprint) throw new Error(`runtime_image_build_${index}_fingerprint_invalid`);
    return { ...recipe, fingerprint: recipeFingerprint };
  });
  return { version: 1, builds };
}

export async function loadRuntimeImageConfig(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024) throw new Error('runtime_image_config_file_invalid');
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error('runtime_image_config_json_invalid', { cause: error }); }
  return normalizeRuntimeImageConfig(parsed);
}

function recipeMap(buildConfig) {
  const normalized = buildConfig ? normalizeRuntimeImageConfig(buildConfig) : { version: 1, builds: [] };
  return new Map(normalized.builds.map((recipe) => [recipe.image, recipe]));
}

function dockerEnvironment(environment = process.env) {
  const path = boundedText(String(environment.PATH ?? ''), 'docker_runtime_path', 16_384);
  return { PATH: path, CI: 'true' };
}

function configuredImages(projects, builds) {
  const images = new Map();
  for (const project of projects ?? []) {
    const image = project?.execution?.image;
    if (typeof image !== 'string' || !image.trim()) continue;
    const normalized = boundedText(image, 'runtime_image', 512);
    const recipe = builds.get(normalized) ?? null;
    const entry = images.get(normalized) ?? {
      image: normalized,
      projects: [],
      digestPinned: digestPinnedImagePattern.test(normalized),
      managedBuild: Boolean(recipe),
      recipeFingerprint: recipe?.fingerprint ?? null
    };
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

async function withAnonymousDockerConfig(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'engineering-orchestrator-docker-'));
  try { return await callback(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
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

async function inspectRecipeLabel(runner, dockerBinary, image, environment) {
  const result = await dockerCommand(
    runner,
    dockerBinary,
    ['image', 'inspect', image, '--format', `{{index .Config.Labels "${runtimeRecipeLabel}"}}`],
    { environment, timeoutMs: 15_000, maxOutputBytes: 8_192 }
  );
  if (result.exitCode !== 0) return null;
  const value = result.stdout.trim();
  return value && value !== '<no value>' ? value : null;
}

function targetWithin(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function sourceBuildContext(recipe, repositoryRoot) {
  const root = resolve(repositoryRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('runtime_build_repository_root_invalid');
  const context = resolve(root, recipe.context);
  if (!targetWithin(root, context) || context === root) throw new Error('runtime_build_context_escapes_repository');

  let cursor = root;
  for (const segment of recipe.context.split('/')) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('runtime_build_context_directory_invalid');
  }

  const entries = await readdir(context, { withFileTypes: true });
  const expectedNames = recipe.files.map((file) => file.path).sort();
  const observedNames = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(observedNames)) throw new Error('runtime_build_context_manifest_mismatch');

  const contents = new Map();
  let totalBytes = 0;
  for (const file of recipe.files) {
    const target = join(context, file.path);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1 || info.size > 128 * 1024) throw new Error('runtime_build_context_file_invalid');
    totalBytes += info.size;
    if (totalBytes > 512 * 1024) throw new Error('runtime_build_context_too_large');
    const data = await readFile(target);
    if (createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error(`runtime_build_context_hash_mismatch:${file.path}`);
    contents.set(file.path, data);
  }
  const dockerfile = contents.get('Dockerfile').toString('utf8');
  const fromLines = dockerfile.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^FROM\s+/i.test(line));
  const immutableBase = /^FROM\s+(?:--platform=[^\s]+\s+)?(?:scratch|[^\s]+@sha256:[a-f0-9]{64})(?:\s+AS\s+[A-Za-z0-9._-]+)?$/i;
  if (fromLines.length < 1 || fromLines.some((line) => !immutableBase.test(line))) throw new Error('runtime_build_base_image_not_pinned');
  return contents;
}

async function stageBuildContext(recipe, repositoryRoot) {
  const contents = await sourceBuildContext(recipe, repositoryRoot);
  const directory = await mkdtemp(join(tmpdir(), 'engineering-orchestrator-build-'));
  try {
    for (const file of recipe.files) await writeFile(join(directory, file.path), contents.get(file.path), { mode: 0o600, flag: 'wx' });
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function isDigestPinnedRuntimeImage(image) {
  return typeof image === 'string' && digestPinnedImagePattern.test(image);
}

export async function projectRuntimeStatus(projects, {
  buildConfig = null,
  repositoryRoot = process.cwd(),
  environment = process.env,
  commandRunner = runLocalCommand,
  dockerBinary = 'docker'
} = {}) {
  const builds = recipeMap(buildConfig);
  const images = configuredImages(projects, builds);
  const probe = await dockerProbe(commandRunner, dockerBinary, environment);
  if (!probe.available) {
    return {
      docker: probe,
      ready: false,
      managedReady: false,
      images: images.map((entry) => ({ ...entry, available: false, trusted: false, action: 'unavailable' }))
    };
  }

  const status = [];
  for (const entry of images) {
    const recipe = builds.get(entry.image);
    if (recipe) {
      try { await sourceBuildContext(recipe, repositoryRoot); }
      catch (error) {
        status.push({ ...entry, available: false, trusted: false, action: 'invalid-recipe', reason: error.message });
        continue;
      }
    }
    const inspected = await inspectImage(commandRunner, dockerBinary, entry.image, environment);
    if (!inspected.available) {
      status.push({ ...entry, ...inspected, trusted: false, action: 'missing' });
      continue;
    }
    if (recipe) {
      const label = await inspectRecipeLabel(commandRunner, dockerBinary, entry.image, environment);
      const trusted = label === recipe.fingerprint;
      status.push({ ...entry, ...inspected, trusted, action: trusted ? 'present' : 'stale', observedRecipeFingerprint: label });
      continue;
    }
    status.push({ ...entry, ...inspected, trusted: entry.digestPinned, action: 'present' });
  }
  return {
    docker: probe,
    ready: status.every((entry) => entry.available && (entry.digestPinned || entry.trusted || !entry.managedBuild)),
    managedReady: status.filter((entry) => entry.digestPinned || entry.managedBuild).every((entry) => entry.available && (entry.digestPinned || entry.trusted)),
    images: status
  };
}

export async function syncProjectRuntimes(projects, {
  buildConfig = null,
  repositoryRoot = process.cwd(),
  environment = process.env,
  commandRunner = runLocalCommand,
  dockerBinary = 'docker',
  pullTimeoutMs = 180_000,
  buildTimeoutMs = 300_000
} = {}) {
  if (!Number.isInteger(pullTimeoutMs) || pullTimeoutMs < 1_000 || pullTimeoutMs > 600_000) throw new Error('runtime_pull_timeout_invalid');
  if (!Number.isInteger(buildTimeoutMs) || buildTimeoutMs < 1_000 || buildTimeoutMs > 900_000) throw new Error('runtime_build_timeout_invalid');
  const builds = recipeMap(buildConfig);
  const images = configuredImages(projects, builds);
  const probe = await dockerProbe(commandRunner, dockerBinary, environment);
  if (!probe.available) throw new Error('docker_runtime_unavailable');

  const status = [];
  for (const entry of images) {
    const recipe = builds.get(entry.image);
    if (recipe) await sourceBuildContext(recipe, repositoryRoot);

    const before = await inspectImage(commandRunner, dockerBinary, entry.image, environment);
    if (before.available && recipe) {
      const label = await inspectRecipeLabel(commandRunner, dockerBinary, entry.image, environment);
      if (label === recipe.fingerprint) {
        status.push({ ...entry, ...before, trusted: true, action: 'present' });
        continue;
      }
    } else if (before.available) {
      status.push({ ...entry, ...before, trusted: entry.digestPinned, action: 'present' });
      continue;
    }

    if (entry.digestPinned) {
      const pulled = await withAnonymousDockerConfig((dockerConfig) => dockerCommand(
        commandRunner,
        dockerBinary,
        ['--config', dockerConfig, 'pull', '--quiet', entry.image],
        { environment, timeoutMs: pullTimeoutMs, maxOutputBytes: 64 * 1024 }
      ));
      if (pulled.exitCode !== 0) throw new Error(`runtime_image_pull_failed:${entry.image}`);
      const after = await inspectImage(commandRunner, dockerBinary, entry.image, environment);
      if (!after.available) throw new Error(`runtime_image_pull_verification_failed:${entry.image}`);
      status.push({ ...entry, ...after, trusted: true, action: 'pulled' });
      continue;
    }

    if (!recipe) {
      status.push({ ...entry, available: false, trusted: false, action: 'manual', reason: 'runtime_image_missing_unmanaged' });
      continue;
    }

    const stagedContext = await stageBuildContext(recipe, repositoryRoot);
    let built;
    try {
      built = await withAnonymousDockerConfig((dockerConfig) => dockerCommand(
        commandRunner,
        dockerBinary,
        [
          '--config', dockerConfig,
          'build',
          '--pull=false',
          '--label', `${runtimeRecipeLabel}=${recipe.fingerprint}`,
          '--tag', entry.image,
          stagedContext
        ],
        { environment, timeoutMs: buildTimeoutMs, maxOutputBytes: 128 * 1024 }
      ));
    } finally {
      await rm(stagedContext, { recursive: true, force: true });
    }
    if (built.exitCode !== 0) throw new Error(`runtime_image_build_failed:${entry.image}`);

    const after = await inspectImage(commandRunner, dockerBinary, entry.image, environment);
    if (!after.available) throw new Error(`runtime_image_build_verification_failed:${entry.image}`);
    const label = await inspectRecipeLabel(commandRunner, dockerBinary, entry.image, environment);
    if (label !== recipe.fingerprint) throw new Error(`runtime_image_build_label_mismatch:${entry.image}`);
    status.push({ ...entry, ...after, trusted: true, action: before.available ? 'rebuilt' : 'built' });
  }

  return {
    docker: probe,
    ready: status.every((entry) => entry.available && (entry.digestPinned || entry.trusted || !entry.managedBuild)),
    managedReady: status.filter((entry) => entry.digestPinned || entry.managedBuild).every((entry) => entry.available && (entry.digestPinned || entry.trusted)),
    images: status,
    missingUnmanaged: status.filter((entry) => !entry.available && !entry.digestPinned && !entry.managedBuild).map((entry) => entry.image)
  };
}
