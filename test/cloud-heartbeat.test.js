import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyLaneObservation, operatorRequestedLanes, planHeartbeat } from '../src/cloud-heartbeat.js';

test('heartbeat classifies recoverable control errors as runnable recovery', () => {
  const state=classifyLaneObservation({lane:'leadfinder',error:'cloud_state_github_request_failed'});
  assert.equal(state.state,'recovery');
  assert.equal(state.runnable,true);
});

test('heartbeat does not retry non-recoverable control failures blindly', () => {
  const state=classifyLaneObservation({lane:'callflow',error:'security_policy_violation'});
  assert.equal(state.state,'blocked');
  assert.equal(state.runnable,false);
});

test('heartbeat prioritizes two business lanes and keeps one spare slot for self', () => {
  const plan=planHeartbeat([
    {lane:'self',hasWork:true},
    {lane:'website-pilot',hasWork:true},
    {lane:'leadfinder',hasWork:true},
    {lane:'callflow',hasWork:true}
  ]);
  assert.deepEqual(plan.dispatch.map((item)=>item.lane),['callflow','leadfinder','self']);
  assert.deepEqual(plan.deferred,[{lane:'website-pilot',priority:'business',reason:'business_capacity'}]);
});

test('active business work consumes capacity and suppresses unnecessary self expansion', () => {
  const plan=planHeartbeat([
    {lane:'callflow',active:true},
    {lane:'leadfinder',active:true},
    {lane:'website-pilot',hasWork:true},
    {lane:'self',hasWork:true}
  ]);
  assert.deepEqual(plan.dispatch.map((item)=>item.lane),['self']);
  assert.equal(plan.deferred.find((item)=>item.lane==='website-pilot').reason,'business_capacity');
});

test('active lane is never dispatched twice', () => {
  const plan=planHeartbeat([
    {lane:'callflow',active:true},
    {lane:'leadfinder',hasWork:true}
  ]);
  assert.deepEqual(plan.dispatch.map((item)=>item.lane),['leadfinder']);
});


test('authorized operator issues map only to configured lanes', () => {
  const config = {
    allowedActors:['palgarra14-del'],
    cloudLanes:[
      {id:'self',projectIds:['self']},
      {id:'callflow',projectIds:['callflow']}
    ]
  };
  const body = (projectId) => '<!-- agent-request:v1 -->\n' + JSON.stringify({version:1,projectId});
  const lanes = operatorRequestedLanes([
    {author:{login:'palgarra14-del'},body:body('self')},
    {author:{login:'someone-else'},body:body('callflow')},
    {author:{login:'palgarra14-del'},body:body('unknown')},
    {author:{login:'palgarra14-del'},body:'malformed'}
  ],config);
  assert.deepEqual(lanes,['self']);
});

test('operator self work outranks ordinary business work when capacity is scarce', () => {
  const plan = planHeartbeat([
    {lane:'self',hasWork:true,operatorRequested:true},
    {lane:'callflow',hasWork:true}
  ],{
    maxHeavy:1,
    maxBusinessHeavy:1,
    maxSelfHeavy:1
  });
  assert.deepEqual(plan.dispatch,[{
    lane:'self',
    priority:'operator',
    reason:'work_detected'
  }]);
  assert.equal(plan.deferred[0].lane,'callflow');
  assert.equal(plan.deferred[0].reason,'global_capacity');
});

test('unauthorized issue content cannot elevate a lane to operator priority', () => {
  const config = {
    allowedActors:['palgarra14-del'],
    cloudLanes:[{id:'self',projectIds:['self']}]
  };
  const lanes = operatorRequestedLanes([{
    author:{login:'attacker'},
    body:'<!-- agent-request:v1 -->\n'+JSON.stringify({version:1,projectId:'self'})
  }],config);
  assert.deepEqual(lanes,[]);
});
