import assert from 'node:assert/strict';
import test from 'node:test';
import {
  academicHealthAttention,
  academicReportFailure,
  degradedAcademicMonitorState,
  healthyAcademicMonitorState
} from '../src/university-health.js';

test('healthy academic monitor does not request attention', () => {
  const state = healthyAcademicMonitorState('2026-09-27T20:00:00Z');
  assert.equal(state.status, 'ready');
  assert.deepEqual(academicHealthAttention(state).items, []);
});

test('degraded academic sources are recognized without touching a live session', () => {
  assert.equal(academicReportFailure({
    summary: { mailStatus: 'ready', gradeStatus: 'ready', notificationStatus: 'ready' }
  }), null);
  assert.equal(academicReportFailure({
    summary: { mailStatus: 'degraded', gradeStatus: 'ready', notificationStatus: 'degraded' }
  }), 'academic_sources_degraded:mail,notifications');
  assert.equal(academicReportFailure(null), 'academic_report_missing');
});

test('a failure opens one stable degradation episode', () => {
  const first = degradedAcademicMonitorState(null, '2026-09-27T20:00:00Z', 'scan_failed');
  const later = degradedAcademicMonitorState(first, '2026-09-27T21:00:00Z', 'scan_failed');
  assert.equal(first.degradedSince, '2026-09-27T20:00:00.000Z');
  assert.equal(later.degradedSince, first.degradedSince);
  assert.deepEqual(
    academicHealthAttention(later).items,
    ['health:2026-09-27T20:00:00.000Z']
  );
});

test('recovery allows a later outage to become a fresh episode', () => {
  const first = degradedAcademicMonitorState(null, '2026-09-27T20:00:00Z');
  const recovered = healthyAcademicMonitorState('2026-09-27T21:00:00Z');
  const second = degradedAcademicMonitorState(recovered, '2026-09-27T22:00:00Z');
  assert.notEqual(second.degradedSince, first.degradedSince);
  assert.equal(academicHealthAttention(second).required, true);
});
