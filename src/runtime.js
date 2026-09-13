import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { runLocalCommand } from './service.js';

const digestPinnedImagePattern = /^[^\s@]+@sha256:[a-f0-9]{64}$/i;
const literalImagePattern = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,511}$/;
const relativePathPattern = /^[A-Za-z0-9._/-]+$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const recipeLabel = 'engineering-orchestrator.runtime.recipe-sha256';

function boundedText(value, label, max = 1_000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`${label}_invalid`);
  return value.trim();
}

function safeRelativePath(value, label) {
  const path = boundedText(value, label, 240).replaceAll('\\', '/');
  if (!relativePathPattern.test(path) || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`${label}_invalid`);
  return path;
}

function recipeFingerprint(recipe) {
  const canonical = JSON.stringify({
    context: recipe.context,
    dockerfile: recipe.dockerfile,
    dockerfileSha256: recipe.dockerfileSha256,
    image: recipe.image
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function dockerEnvironment(environment = process.env) {
  const path = boundedText(String(environment.PATH ?? ''), 'docker_runtime_path', 16_384);
  return { PATH: path, CI: 'true' };
}

export function normalizeRuntimeRecipes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.recipes)) throw new Error('runtime_recipe_config_invalid');
  const seen = new Set();
  const recipes = value.recipes.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('runtime_recipe_invalid');
    const keys = Object.keys(candidate).sort().join(',');
    if (keys !== ['context', 'dockerfile', 'dockerfileSha256', 'image'].sort().join(',')) throw new Error('runtime_recipe_fields_invalid');
    const image = boundedText(candidate.image, 'runtime_recipe_image', 512);
    if (!literalImagePattern.test(image) || digestPinnedImagePattern.test(image)) throw new Error('runtime_recipe_image_invalid');
    if (seen.has(image)) throw new Error('runtime_recipe_duplicate_image');
    seen.add(image);
    const context = safeRelativePath(candidate.context, 'runtime_recipe_context');
    const dockerfile = safeRelativePath(candidate.dockerfile, 'runtime_recipe_dockerfile');
    const dockerfileSha256 = boundedText(candidate.dockerfileSha256, 'runtime_recipe_sha256', 64).toLowerCase();
    if (!sha256Pattern.test(dockerfileSha256)) throw new Error('runtime_recipe_sha256_invalid');
    const recipe = { image, context, dockerfile, dockerfileSha256 };
    return { ...recipe, fingerprint: recipeFingerprint(recipe) };
  });
  return { version: 1, recipes };
}

export async function loadRuntimeRecipes(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1 || info.size > 64 * 1024) throw new Error('runtime_recipe_config_file_invalid');
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error('runtime_recipe_config_json_invalid', { cause: error }); }
  return normalizeRuntimeRecipes(parsed);
}

async function activeRuntimeRecipes(runtimeRecipes, repositoryRoot) {
  if (runtimeRecipes !== undefined && runtimeRecipes !== null) return normalizeRuntimeRecipes(runtimeRecipes);
  return loadRuntimeRecipes(resolve(repositoryRoot, 'config/runtime-images.json'));
}

function recipeMap(runtimeRecipes) {
  return new Map(runtimeRecipes.recipes.map((recipe) => [recipe.image, recipe]));
}

function configuredImages(projects, recipes) {
  const images = new Map();
  for (const project of projects ?? []) {
    const image = project?.execution?.image;
    if (typeof image !== 'string' || !image.trim()) continue;
    const normalized = boundedText(image, 'runtime_image', 512);
    if (!literalImagePattern.test(normalized)) throw new Error('runtime_image_invalid');
    const recipe = recipes.get(normalized) ?? null;
    const entry = images.get(normalized) ?? {
      image: normalized,
      projects: [],
      digestPinned: digestPinnedImagePattern.test(normalized),
      recipeManaged: Boolean(recipe),
      recipeFingerprint: recipe?.fingerprint ?? null
    };
    if (typeof project.id === 'string' && project.id) entry.projects.push(project.id);
    images.set(normalized, entry);
  }
  return [...images.values()].map((entry) => ({ ...entry, projects: [...new Set(entry.projects)].sort() }));
}

async function dockerCommand(runner, dockerBinary, args, { environment, timeoutMs = 15_000, maxOutputBytes = 32_768, cwd = process.cwd() } = {}) {
  const result = await runner(dockerBinary, args, {
    cwd,
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

async function inspectImage(runner, dockerBinary, image, environment, expectedRecipeFingerprint = null) {
  const result = await dockerCommand(runner, dockerBinary, ['image', 'inspect', image, '--format', '{{.Id}}'], { environment, timeoutMs: 15_000, maxOutputBytes: 8_192 });
  if (result.exitCode !== 0 || !result.stdout.trim()) return { available: false };
  const imageId = result.stdout.trim();
  if (!expectedRecipeFingerprint) return { available: true, imageId };
  const label = await dockerCommand(runner, dockerBinary, ['image', 'inspect', image, '--format', `{{ index .Config.Labels "${recipeLabel}" }}`], { environment, timeoutMs: 15_000, maxOutputBytes: 8_192 });
  const observedRecipeFingerprint = label.exitCode === 0 ? label.stdout.trim() : '';
  if (observedRecipeFingerprint !== expectedRecipeFingerprint) {
    return { available: false, imageId, recipeVerified: false, observedRecipeFingerprint: observedRecipeFingerprint || null };
  }
  return { available: true, imageId, recipeVerified: true, observedRecipeFingerprint };
}

async function verifyRealPath(root, candidate, type, errorCode) {
  const rootPath = resolve(root);
  const target = resolve(rootPath, candidate);
  const rel = relative(rootPath, target);
  if (!rel || rel.startsWith('..') || rel.startsWith('/') || rel.startsWith('\\')) throw new Error(errorCode);
  const parts = rel.split(/[\\/]/);
  let current = rootPath;
  const rootInfo = await lstat(rootPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('runtime_recipe_root_invalid');
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(errorCode);
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error(errorCode);
    if (index === parts.length - 1) {
      if (type === 'file' && (!info.isFile() || Number(info.nlink) !== 1)) throw new Error(errorCode);
      if (type === 'directory' && !info.isDirectory()) throw new Error(errorCode);
    }
  }
  return target;
}

async function verifiedBuildRecipe(recipe, repositoryRoot) {
  const context = await verifyRealPath(repositoryRoot, recipe.context, 'directory', 'runtime_recipe_context_invalid');
  const dockerfile = await verifyRealPath(repositoryRoot, recipe.dockerfile, 'file', 'runtime_recipe_dockerfile_invalid');
  const relativeToContext = relative(context, dockerfile);
  if (!relativeToContext || relativeToContext.startsWith('..') || relativeToContext.startsWith('/') || relativeToContext.startsWith('\\')) throw new Error('runtime_recipe_dockerfile_outside_context');
  const content = await readFile(dockerfile);
  if (content.length > 64 * 1024) throw new Error('runtime_recipe_dockerfile_too_large');
  const actual = createHash('sha256').update(content).digest('hex');
  if (actual !== recipe.dockerfileSha256) throw new Error('runtime_recipe_dockerfile_hash_mismatch');
  return { context, dockerfile };
}

async function withAnonymousDockerConfig(callback) {
  const dockerConfig = await mkdtemp(join(tmpdir(), 'engineering-orchestrator-docker-'));
  try { return await callback(dockerConfig); }
  finally { await rm(dockerConfig, { recursive: true, force: true }); }
}

export function isDigestPinnedRuntimeImage(image) {
  return typeof image === 'string' && digestPinnedImagePattern.test(image);
}

export async function projectRuntimeStatus(projects, {
  environment = process.env,
  commandRunner = runLocalCommand,
  dockerBinary = 'docker',
  runtimeRecipes,
  repositoryRoot = process.cwd()
} = {}) {
  const normalizedRecipes = await activeRuntimeRecipes(runtimeRecipes, repositoryRoot);
  const recipes = recipeMap(normalizedRecipes);
  const images = configuredImages(projects, recipes);
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
    const inspected = await inspectImage(commandRunner, dockerBinary, entry.image, environment, entry.recipeFingerprint);
    status.push({ ...entry, ...inspected, action: inspected.available ? 'present' : entry.recipeManaged && inspected.imageId ? 'stale-recipe' : 'missing' });
  }
  return {
    docker: probe,
    ready: status.every((entry) => entry.available),
    managedReady: status.filter((entry) => entry.digestPinned || entry.recipeManaged).every((entry) => entry.available),
    images: status
  };
}

export async function syncProjectRuntimes(projects, {
  environment = process.env,
  commandRunner = runLocalCommand,
  dockerBinary = 'docker',
  pullTimeoutMs = 180_000,
  buildTimeoutMs = 300_000,
  runtimeRecipes,
  repositoryRoot = process.cwd()
} = {}) {
  if (!Number.isInteger(pullTimeoutMs) || pullTimeoutMs < 1_000 || pullTimeoutMs > 600_000) throw new Error('runtime_pull_timeout_invalid');
  if (!Number.isInteger(buildTimeoutMs) || buildTimeoutMs < 1_000 || buildTimeoutMs > 900_000) throw new Error('runtime_build_timeout_invalid');
  const normalizedRecipes = await activeRuntimeRecipes(runtimeRecipes, repositoryRoot);
  const recipes = recipeMap(normalizedRecipes);
  const images = configuredImages(projects, recipes);
  const probe = await dockerProbe(commandRunner, dockerBinary, environment);
  if (!probe.available) throw new Error('docker_runtime_unavailable');

  const status = [];
  for (const entry of images) {
    const before = await inspectImage(commandRunner, dockerBinary, entry.image, environment, entry.recipeFingerprint);
    if (before.available) {
      status.push({ ...entry, ...before, action: 'present' });
      continue;
    }

    if (entry.digestPinned) {
      const pulled = await withAnonymousDockerConfig((dockerConfig) => dockerCommand(commandRunner, dockerBinary, ['--config', dockerConfig, 'pull', '--quiet', entry.image], {
        environment,
        timeoutMs: pullTimeoutMs,
        maxOutputBytes: 64 * 1024
      }));
      if (pulled.exitCode !== 0) throw new Error(`runtime_image_pull_failed:${entry.image}`);
      const after = await inspectImage(commandRunner, dockerBinary, entry.image, environment);
      if (!after.available) throw new Error(`runtime_image_pull_verification_failed:${entry.image}`);
      status.push({ ...entry, ...after, action: 'pulled' });
      continue;
    }

    const recipe = recipes.get(entry.image);
    if (!recipe) {
      status.push({ ...entry, available: false, action: 'manual', reason: 'runtime_image_missing_unmanaged' });
      continue;
    }

    const verified = await verifiedBuildRecipe(recipe, repositoryRoot);
    const built = await withAnonymousDockerConfig((dockerConfig) => dockerCommand(commandRunner, dockerBinary, [
      '--config', dockerConfig,
      'build', '--pull=false',
      '--label', `${recipeLabel}=${recipe.fingerprint}`,
      '--file', verified.dockerfile,
      '--tag', entry.image,
      verified.context
    ], {
      environment,
      timeoutMs: buildTimeoutMs,
      maxOutputBytes: 128 * 1024,
      cwd: resolve(repositoryRoot)
    }));
    if (built.exitCode !== 0) throw new Error(`runtime_image_build_failed:${entry.image}`);
    const after = await inspectImage(commandRunner, dockerBinary, entry.image, environment, recipe.fingerprint);
    if (!after.available || !after.recipeVerified) throw new Error(`runtime_image_build_verification_failed:${entry.image}`);
    status.push({ ...entry, ...after, action: before.imageId ? 'rebuilt' : 'built' });
  }

  return {
    docker: probe,
    ready: status.every((entry) => entry.available),
    managedReady: status.filter((entry) => entry.digestPinned || entry.recipeManaged).every((entry) => entry.available),
    images: status,
    missingUnmanaged: status.filter((entry) => !entry.available && !entry.digestPinned && !entry.recipeManaged).map((entry) => entry.image)
  };
}
