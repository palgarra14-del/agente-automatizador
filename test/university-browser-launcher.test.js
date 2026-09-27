import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('../scripts/start-university-chrome.ps1', import.meta.url), 'utf8');

test('university Chrome launcher binds debugging to Windows loopback only', () => {
  assert.match(script, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(script, /--remote-debugging-port=\$Port/);
  assert.doesNotMatch(script, /0\.0\.0\.0/);
});

test('university Chrome launcher uses a dedicated profile and requires HTTPS', () => {
  assert.match(script, /AgentUniversityChrome/);
  assert.match(script, /Scheme -ne "https"/);
  assert.match(script, /credential-free HTTPS/);
  assert.doesNotMatch(script, /password|token|cookie/i);
});

test('university Chrome launcher does not use the normal Chrome profile', () => {
  assert.match(script, /--user-data-dir=\$ProfilePath/);
  assert.doesNotMatch(script, /User Data\\Default/);
});
