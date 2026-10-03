import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyOperatorControl,
  globalPauseEnabled,
  parsePausedLanes,
  serializePausedLanes
} from '../src/operator-control.js';

const lanes = ['self','website-pilot','leadfinder','callflow'];

test('operator control parses only configured paused lanes', () => {
  assert.equal(globalPauseEnabled('TRUE'), true);
  assert.equal(globalPauseEnabled('false'), false);
  assert.deepEqual(parsePausedLanes('leadfinder, callflow,unknown,leadfinder', lanes), ['callflow','leadfinder']);
  assert.equal(serializePausedLanes(['leadfinder','callflow','leadfinder']), 'callflow,leadfinder');
});

test('operator global pause blocks every new lane wakeup', () => {
  assert.deepEqual(applyOperatorControl(lanes, {globalPause:true, pausedLanes:[]}), []);
});

test('operator lane pause blocks only selected lanes', () => {
  assert.deepEqual(
    applyOperatorControl(lanes, {globalPause:false, pausedLanes:['leadfinder','self']}),
    ['website-pilot','callflow']
  );
});
