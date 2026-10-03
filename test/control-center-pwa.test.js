import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const root = new URL('../control-center/public/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', root), 'utf8'));
const html = readFileSync(new URL('index.html', root), 'utf8');
const app = readFileSync(new URL('app.js', root), 'utf8');
const sw = readFileSync(new URL('sw.js', root), 'utf8');

function pngSize(name) {
  const buf = readFileSync(new URL(name, root));
  assert.deepEqual([...buf.subarray(0,8)], [137,80,78,71,13,10,26,10]);
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

test('Control Center manifest satisfies installable PWA essentials', () => {
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.name);
  assert.ok(manifest.short_name);
  assert.ok(manifest.icons.some((icon) => icon.src === '/icon-192.png' && icon.sizes === '192x192' && icon.type === 'image/png'));
  assert.ok(manifest.icons.some((icon) => icon.src === '/icon-512.png' && icon.sizes === '512x512' && icon.type === 'image/png'));
  assert.ok(manifest.icons.some((icon) => icon.src === '/icon-maskable-512.png' && icon.sizes === '512x512' && icon.purpose === 'maskable'));
});

test('Control Center ships real raster icons at required sizes', () => {
  assert.deepEqual(pngSize('icon-192.png'), [192,192]);
  assert.deepEqual(pngSize('icon-512.png'), [512,512]);
  assert.deepEqual(pngSize('icon-maskable-512.png'), [512,512]);
  assert.deepEqual(pngSize('apple-touch-icon.png'), [180,180]);
});

test('Control Center advertises install metadata and native install prompt', () => {
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
  assert.match(html, /id="installAppBtn"/);
  assert.match(app, /beforeinstallprompt/);
  assert.match(app, /appinstalled/);
  assert.match(app, /navigator\.serviceWorker\.register\('\/sw\.js'\)/);
});

test('service worker precaches install assets and evicts obsolete caches', () => {
  for (const asset of ['/manifest.webmanifest','/icon-192.png','/icon-512.png','/icon-maskable-512.png','/apple-touch-icon.png']) {
    assert.match(sw, new RegExp(asset.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')));
  }
  assert.match(sw, /caches\.keys\(\)/);
  assert.match(sw, /caches\.delete/);
  assert.match(sw, /skipWaiting/);
});
