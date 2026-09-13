import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { maskSecrets, readBoundedRegularFile, runProcess } from './core.js';

export const VISUAL_CAPTURE_IMAGE = 'agent-visual-review:1.62.1';
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const expectedCaptures = new Map([['desktop', [1440, 900]], ['mobile', [390, 844]]]);

export function normalizePreviewUrl(value) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { throw new Error('visual_preview_url_invalid'); }
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.vercel.app') ||
    url.username ||
    url.password ||
    url.hash ||
    url.port
  ) throw new Error('visual_preview_url_not_allowed');
  return url.href;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function validateCaptureFile(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1) throw new Error('visual_capture_file_invalid');
  const content = await readBoundedRegularFile(file, { maxBytes: 8 * 1024 * 1024, label: 'Visual capture', requireSingleLink: true });
  if (content.byteLength < pngSignature.byteLength || !content.subarray(0, pngSignature.byteLength).equals(pngSignature)) throw new Error('visual_capture_not_png');
  return { bytes: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') };
}

function parseCaptureOutput(raw, previewUrl) {
  let parsed;
  try { parsed = JSON.parse(String(raw ?? '')); } catch { throw new Error('visual_capture_output_invalid_json'); }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.captures) || parsed.captures.length !== 2 || !Array.isArray(parsed.blockedOrigins)) {
    throw new Error('visual_capture_output_invalid');
  }
  const expectedOrigin = new URL(previewUrl).origin;
  if (parsed.origin !== expectedOrigin || new URL(parsed.finalUrl).origin !== expectedOrigin) throw new Error('visual_capture_origin_mismatch');
  if (parsed.blockedOrigins.length > 50 || parsed.blockedOrigins.some((value) => typeof value !== 'string' || value.length > 300)) throw new Error('visual_capture_blocked_origins_invalid');
  const byName = new Map(parsed.captures.map((capture) => [capture?.name, capture]));
  for (const [name, [width, height]] of expectedCaptures) {
    const capture = byName.get(name);
    if (!capture || capture.width !== width || capture.height !== height || capture.path !== `/output/${name}.png`) throw new Error('visual_capture_viewport_invalid');
  }
  return {
    finalUrl: parsed.finalUrl,
    title: String(parsed.title ?? '').slice(0, 300),
    blockedOrigins: [...new Set(parsed.blockedOrigins)].sort(),
    captures: [...expectedCaptures.keys()].map((name) => byName.get(name))
  };
}

export class ContainerVisualCaptureProvider {
  constructor({ image = VISUAL_CAPTURE_IMAGE, processRunner = runProcess, environment = process.env } = {}) {
    this.image = image;
    this.processRunner = processRunner;
    this.environment = environment;
  }

  async available() {
    const result = await this.processRunner('docker', ['image', 'inspect', this.image], {
      timeoutMs: 15_000,
      outputLimit: 4_096,
      restrictEnvironment: true,
      env: { PATH: this.environment.PATH ?? '' }
    });
    return !result.timedOut && result.exitCode === 0;
  }

  async capture(previewUrl, { timeoutMs = 60_000 } = {}) {
    const url = normalizePreviewUrl(previewUrl);
    if (!await this.available()) throw new Error('visual_capture_image_unavailable');
    const outputDirectory = await mkdtemp(join(tmpdir(), 'agent-visual-'));
    await chmod(outputDirectory, 0o700);
    const containerName = `agent-visual-${randomUUID()}`;
    let keep = true;
    try {
      const args = [
        'run', '--rm', '--name', containerName, '--init',
        '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges=true',
        '--pids-limit', '128', '--memory', '768m', '--cpus', '1', '--shm-size', '256m',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--network', 'bridge',
        '--volume', `${resolve(outputDirectory)}:/output:rw`,
        '--env', 'HOME=/tmp', '--env', `PREVIEW_URL=${url}`,
        this.image
      ];
      const result = await this.processRunner('docker', args, {
        timeoutMs,
        outputLimit: 32_768,
        restrictEnvironment: true,
        env: { PATH: this.environment.PATH ?? '' }
      });
      if (result.timedOut || result.exitCode !== 0 || result.stdoutTruncated) {
        throw new Error(`visual_capture_failed:${maskSecrets(result.stderr || result.stdout || (result.timedOut ? 'timeout' : 'unknown'))}`);
      }
      const output = parseCaptureOutput(result.stdout, url);
      const screenshots = [];
      for (const [name, [width, height]] of expectedCaptures) {
        const path = join(outputDirectory, `${name}.png`);
        const file = await validateCaptureFile(path);
        screenshots.push({ name, width, height, ...file });
      }
      const evidence = {
        version: 1,
        previewUrl: url,
        finalUrl: output.finalUrl,
        title: output.title,
        blockedOrigins: output.blockedOrigins,
        screenshots
      };
      evidence.fingerprint = fingerprint(evidence);
      const cleanup = async () => {
        if (!keep) return;
        keep = false;
        await rm(outputDirectory, { recursive: true, force: true });
      };
      return { evidence, imagePaths: screenshots.map((item) => join(outputDirectory, `${item.name}.png`)), cleanup };
    } catch (error) {
      await rm(outputDirectory, { recursive: true, force: true });
      throw error;
    } finally {
      await this.processRunner('docker', ['rm', '--force', containerName], {
        timeoutMs: 10_000,
        outputLimit: 2_048,
        restrictEnvironment: true,
        env: { PATH: this.environment.PATH ?? '' }
      }).catch(() => {});
    }
  }
}
