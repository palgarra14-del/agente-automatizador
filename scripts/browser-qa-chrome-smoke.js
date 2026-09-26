import assert from 'node:assert/strict';
import { launchChromeCdpBrowser } from '../src/browser-qa-runner.js';

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 30_000);
let browser = null;
try {
  browser = await launchChromeCdpBrowser({ signal: controller.signal, timeoutMs: 20_000 });
  const version = await browser.version();
  assert.equal(typeof version.product, 'string');
  assert.match(version.product, /Chrome|Chromium/i);
  console.log(`Browser QA Chrome/CDP smoke PASS: ${version.product}`);
} finally {
  clearTimeout(timer);
  await browser?.close();
}
