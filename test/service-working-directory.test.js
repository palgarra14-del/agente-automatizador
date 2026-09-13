import assert from 'node:assert/strict';
import test from 'node:test';
import { renderInboxServiceUnit } from '../src/service.js';

test('systemd WorkingDirectory is emitted as an absolute unquoted path', () => {
  const unit = renderInboxServiceUnit({
    repositoryRoot: '/home/pablo/projects/agente-automatizador',
    nodePath: '/usr/bin/node',
    home: '/home/pablo'
  });

  assert.match(unit, /^WorkingDirectory=\/home\/pablo\/projects\/agente-automatizador$/m);
  assert.doesNotMatch(unit, /^WorkingDirectory="/m);
});
