import assert from 'node:assert/strict';
import test from 'node:test';
import { routeCloudLanes } from '../scripts/cloud-lane-route.js';

const config = {
  cloudLanes: [
    { id: 'self', projectIds: ['self'] },
    { id: 'website-pilot', projectIds: ['website-pilot'] },
    { id: 'callflow', projectIds: ['callflow'] }
  ]
};

const body = (projectId) => `<!-- agent-request:v1 -->
${JSON.stringify({
  version: 1,
  projectId,
  profile: projectId === 'website-pilot' ? 'website-build' : 'app-improvement',
  goal: 'bounded test',
  scope: { allowedPaths: ['src'] }
})}`;

test('trusted main pushes wake self only while scheduled and manual recovery cover every lane', () => {
  assert.deepEqual(routeCloudLanes({ eventName: 'push', config }), ['self']);
  assert.deepEqual(routeCloudLanes({ eventName: 'schedule', config }), ['self', 'website-pilot', 'callflow']);
  assert.deepEqual(routeCloudLanes({ eventName: 'workflow_dispatch', config }), ['self', 'website-pilot', 'callflow']);
});

test('workflow dispatch continuation may target exactly one configured lane', () => {
  assert.deepEqual(routeCloudLanes({
    eventName: 'workflow_dispatch',
    requestedLane: 'callflow',
    config
  }), ['callflow']);
  assert.throws(() => routeCloudLanes({
    eventName: 'workflow_dispatch',
    requestedLane: '../escape',
    config
  }), /requested_lane_invalid/);
  assert.throws(() => routeCloudLanes({
    eventName: 'workflow_dispatch',
    requestedLane: 'unknown',
    config
  }), /requested_lane_invalid/);
});

test('issue events route a valid request to exactly its configured owning lane', () => {
  assert.deepEqual(routeCloudLanes({ eventName: 'issues', eventAction: 'opened', issueBody: body('self'), config }), ['self']);
  assert.deepEqual(routeCloudLanes({ eventName: 'issues', eventAction: 'opened', issueBody: body('website-pilot'), config }), ['website-pilot']);
  assert.deepEqual(routeCloudLanes({ eventName: 'issue_comment', issueBody: body('callflow'), config }), ['callflow']);
});

test('issue edits and reopens conservatively wake every lane so prior ownership can invalidate', () => {
  const all = ['self', 'website-pilot', 'callflow'];
  assert.deepEqual(routeCloudLanes({ eventName: 'issues', eventAction: 'edited', issueBody: body('self'), config }), all);
  assert.deepEqual(routeCloudLanes({ eventName: 'issues', eventAction: 'reopened', issueBody: body('callflow'), config }), all);
});

test('ambiguous or malformed event bodies fall back to every trusted lane', () => {
  const all = ['self', 'website-pilot', 'callflow'];
  assert.deepEqual(routeCloudLanes({ eventName: 'issues', eventAction: 'opened', issueBody: '', config }), all);
  assert.deepEqual(routeCloudLanes({ eventName: 'issues', eventAction: 'opened', issueBody: 'prefix\n' + body('self'), config }), all);
  assert.deepEqual(routeCloudLanes({ eventName: 'issues', eventAction: 'opened', issueBody: '<!-- agent-request:v1 -->\n{bad json', config }), all);
  assert.deepEqual(routeCloudLanes({ eventName: 'issues', eventAction: 'opened', issueBody: body('unknown-project'), config }), all);
  assert.deepEqual(routeCloudLanes({ eventName: 'unexpected', issueBody: body('callflow'), config }), all);
});

test('untrusted issue content can never create a dynamic lane name', () => {
  const malicious = body('evil-lane').replace('"evil-lane"', '"agent-$' + '{{ github.actor }}"');
  assert.deepEqual(routeCloudLanes({ eventName: 'issues', eventAction: 'opened', issueBody: malicious, config }), ['self', 'website-pilot', 'callflow']);
});

test('trusted routing configuration rejects duplicate or invalid ownership', () => {
  assert.throws(() => routeCloudLanes({
    eventName: 'schedule',
    config: { cloudLanes: [{ id: 'self', projectIds: ['same'] }, { id: 'callflow', projectIds: ['same'] }] }
  }), /project_overlap/);
  assert.throws(() => routeCloudLanes({
    eventName: 'schedule',
    config: { cloudLanes: [{ id: '../escape', projectIds: ['self'] }] }
  }), /config_invalid/);
  assert.throws(() => routeCloudLanes({
    eventName: 'schedule',
    config: { cloudLanes: [] }
  }), /config_invalid/);
});
