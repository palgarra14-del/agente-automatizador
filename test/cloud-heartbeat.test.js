import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyLaneObservation, criticalCiDemand, heartbeatControlAuthUnavailable, heartbeatExecutionMode, heartbeatObservationOrder, heartbeatRunLane, localCloudUnitName, operatorRequestedLanes, planHeartbeat } from '../src/cloud-heartbeat.js';

test('critical CI demand counts only waiting CI runs', () => {
  assert.equal(criticalCiDemand([
    {name:'CI',status:'queued'},
    {name:'CI',status:'pending'},
    {name:'CI',status:'in_progress'},
    {name:'CI',status:'completed'},
    {name:'Agent Cloud Worker',status:'queued'}
  ]),2);
});

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

test('heartbeat defers expired local GitHub auth to scheduled cloud recovery', () => {
  assert.equal(heartbeatControlAuthUnavailable('GitHub issue queue request failed: 401'), true);
  assert.equal(heartbeatControlAuthUnavailable('github_cli_auth_required'), true);
  assert.equal(heartbeatControlAuthUnavailable('GitHub issue queue request failed: 403'), false);
  assert.equal(heartbeatControlAuthUnavailable('cloud_state_github_rate_limited:403'), false);
  assert.equal(heartbeatControlAuthUnavailable('security_policy_violation'), false);
  const state=classifyLaneObservation({lane:'callflow',controlUnavailable:true,operatorRequested:true});
  assert.deepEqual(state,{
    lane:'callflow',
    state:'deferred',
    runnable:false,
    reason:'local_control_auth_unavailable',
    operatorRequested:true
  });
});

test('local-primary heartbeat can hand one lane to the governed drain without a duplicate deep peek', () => {
  const state=classifyLaneObservation({lane:'callflow',localPrimaryProbe:true,operatorRequested:true});
  assert.deepEqual(state,{
    lane:'callflow',
    state:'pending',
    runnable:true,
    reason:'local_primary_probe',
    operatorRequested:true
  });
});

test('heartbeat defers lanes it could not observe within the cycle budget', () => {
  const state=classifyLaneObservation({lane:'website-pilot',observationSkipped:true});
  assert.deepEqual(state,{
    lane:'website-pilot',
    state:'deferred',
    runnable:false,
    reason:'observation_budget',
    operatorRequested:false
  });
});

test('heartbeat defers a lane while its exact rate-limit retry timer is pending', () => {
  const state=classifyLaneObservation({
    lane:'leadfinder',
    rateLimitCooldown:true,
    hasWork:true,
    operatorRequested:true
  });
  assert.deepEqual(state,{
    lane:'leadfinder',
    state:'deferred',
    runnable:false,
    reason:'rate_limit_cooldown',
    operatorRequested:true
  });
  const plan=planHeartbeat([
    {lane:'leadfinder',rateLimitCooldown:true,hasWork:true,operatorRequested:true},
    {lane:'callflow',hasWork:true}
  ],{maxHeavy:2,maxBusinessHeavy:2,maxSelfHeavy:1});
  assert.deepEqual(plan.dispatch.map((item)=>item.lane),['callflow']);
  assert.equal(plan.classified.find((item)=>item.lane==='leadfinder').reason,'rate_limit_cooldown');
});

test('heartbeat observes business lanes before self unless the operator explicitly requested self', () => {
  assert.deepEqual(
    heartbeatObservationOrder(['self','website-pilot','leadfinder','callflow']),
    ['callflow','leadfinder','website-pilot','self']
  );
  assert.deepEqual(
    heartbeatObservationOrder(['self','website-pilot','leadfinder','callflow'],new Set(['self'])),
    ['self','callflow','leadfinder','website-pilot']
  );
});

test('heartbeat rotates ordinary business observation order so a slow earlier lane cannot starve website pilot forever', () => {
  const lanes=['self','website-pilot','leadfinder','callflow'];
  assert.deepEqual(
    heartbeatObservationOrder(lanes,new Set(),1),
    ['leadfinder','website-pilot','callflow','self']
  );
  assert.deepEqual(
    heartbeatObservationOrder(lanes,new Set(),2),
    ['website-pilot','callflow','leadfinder','self']
  );
  assert.deepEqual(
    heartbeatObservationOrder(lanes,new Set(['callflow']),1),
    ['callflow','website-pilot','leadfinder','self']
  );
});

test('heartbeat rotates multiple operator-requested business lanes instead of starving later lanes', () => {
  const lanes=['self','website-pilot','leadfinder','callflow'];
  const operator=new Set(['callflow','leadfinder','website-pilot']);
  assert.deepEqual(
    heartbeatObservationOrder(lanes,operator,0),
    ['callflow','leadfinder','website-pilot','self']
  );
  assert.deepEqual(
    heartbeatObservationOrder(lanes,operator,1),
    ['leadfinder','website-pilot','callflow','self']
  );
  assert.deepEqual(
    heartbeatObservationOrder(lanes,operator,2),
    ['website-pilot','callflow','leadfinder','self']
  );
});

test('heartbeat observation rotation is bounded for large and negative counters', () => {
  const lanes=['callflow','leadfinder','website-pilot','self'];
  assert.deepEqual(
    heartbeatObservationOrder(lanes,new Set(),5),
    ['website-pilot','callflow','leadfinder','self']
  );
  assert.deepEqual(
    heartbeatObservationOrder(lanes,new Set(),-1),
    ['website-pilot','callflow','leadfinder','self']
  );
});

test('heartbeat recognizes queued lane-scoped dispatches before jobs are materialized', () => {
  const lanes=['self','website-pilot','leadfinder','callflow'];
  assert.equal(heartbeatRunLane({
    event:'workflow_dispatch',
    displayTitle:'Agent Cloud Worker (leadfinder)'
  },lanes),'leadfinder');
  assert.equal(heartbeatRunLane({
    event:'push',
    displayTitle:'Agent Cloud Worker (leadfinder)'
  },lanes),null);
  assert.equal(heartbeatRunLane({
    event:'workflow_dispatch',
    displayTitle:'Agent Cloud Worker (unknown)'
  },lanes),null);
  assert.equal(heartbeatRunLane({
    event:'workflow_dispatch',
    displayTitle:'Agent Cloud Worker'
  },lanes),null);
});

test('heartbeat fills all runner capacity with business before self', () => {
  const plan=planHeartbeat([
    {lane:'self',hasWork:true},
    {lane:'website-pilot',hasWork:true},
    {lane:'leadfinder',hasWork:true},
    {lane:'callflow',hasWork:true}
  ]);
  assert.deepEqual(plan.dispatch.map((item)=>item.lane),['callflow','leadfinder','website-pilot']);
  assert.deepEqual(plan.deferred,[{lane:'self',priority:'maintenance',reason:'global_capacity'}]);
});


test('heartbeat surfaces the current autoranking before dispatch', () => {
  const plan=planHeartbeat([
    {lane:'self',hasWork:true},
    {lane:'website-pilot',hasWork:true},
    {lane:'leadfinder',hasWork:true},
    {lane:'callflow',hasWork:true}
  ],{maxHeavy:2,maxBusinessHeavy:2,maxSelfHeavy:1});

  assert.deepEqual(plan.ranking.map((item)=>item.lane),[
    'callflow','leadfinder','website-pilot','self'
  ]);
  assert.deepEqual(plan.ranking.map((item)=>item.rank),[1,2,3,4]);
  assert.deepEqual(plan.dispatch.map((item)=>item.lane),['callflow','leadfinder']);
});

test('active business work leaves the last runner for waiting business before self', () => {
  const plan=planHeartbeat([
    {lane:'callflow',active:true},
    {lane:'leadfinder',active:true},
    {lane:'website-pilot',hasWork:true},
    {lane:'self',hasWork:true}
  ]);
  assert.deepEqual(plan.dispatch.map((item)=>item.lane),['website-pilot']);
  assert.equal(plan.deferred.find((item)=>item.lane==='self').reason,'global_capacity');
});

test('queued CI reserves spare runner capacity from self maintenance', () => {
  const plan=planHeartbeat([
    {lane:'callflow',active:true},
    {lane:'leadfinder',active:true},
    {lane:'self',hasWork:true}
  ],{
    reserveForExternal:1
  });
  assert.deepEqual(plan.dispatch,[]);
  assert.equal(plan.deferred[0].lane,'self');
  assert.equal(plan.deferred[0].reason,'external_priority_capacity');
  assert.equal(plan.externalPriorityDemand,1);
});

test('self recovery still outranks queued CI pressure', () => {
  const plan=planHeartbeat([
    {lane:'callflow',active:true},
    {lane:'leadfinder',active:true},
    {lane:'self',error:'cloud_state_github_request_failed'}
  ],{
    reserveForExternal:1
  });
  assert.deepEqual(plan.dispatch.map((item)=>item.lane),['self']);
});

test('active lane is never dispatched twice', () => {
  const plan=planHeartbeat([
    {lane:'callflow',active:true},
    {lane:'leadfinder',hasWork:true}
  ]);
  assert.deepEqual(plan.dispatch.map((item)=>item.lane),['leadfinder']);
});

test('waiting business asks a running self lane to yield at the next safe checkpoint', () => {
  const plan=planHeartbeat([
    {lane:'self',active:true},
    {lane:'leadfinder',active:true},
    {lane:'website-pilot',active:true},
    {lane:'callflow',hasWork:true}
  ]);
  assert.deepEqual(plan.dispatch,[]);
  assert.deepEqual(plan.yieldCandidates,[{
    id:'running:self',
    lane:'self',
    reason:'yield_at_next_safe_checkpoint_for_business_work'
  }]);
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


test('heartbeat execution mode validates local-primary and cloud modes', () => {
  assert.equal(heartbeatExecutionMode('cloud'), 'cloud');
  assert.equal(heartbeatExecutionMode('LOCAL-PRIMARY'), 'local-primary');
  assert.throws(() => heartbeatExecutionMode('remote-magic'), /heartbeat_execution_mode_invalid/);
});

test('local cloud unit names are deterministic and lane-scoped', () => {
  assert.equal(localCloudUnitName('callflow'), 'agent-local-cloud-callflow');
  assert.equal(localCloudUnitName('website-pilot'), 'agent-local-cloud-website-pilot');
  assert.throws(() => localCloudUnitName('../bad'), /heartbeat_lane_invalid/);
});
