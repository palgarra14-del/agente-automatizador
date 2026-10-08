import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = resolve('scripts/design-lab/blocker-doctor.py');

function diagnose(bundle) {
  const source = `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("doctor", ${JSON.stringify(script)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(m.deterministic_diagnosis(json.loads(sys.argv[1]))))
`;
  const run=spawnSync('python3',['-c',source,JSON.stringify(bundle)],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr || run.stdout);
  return JSON.parse(run.stdout);
}

function baseBundle() {
  return {
    service:{activeState:'inactive',subState:'dead',result:'success',execMainStatus:'0'},
    timers:{lab:true,guardian:true},
    git:{branch:'main',dirty:false,status:''},
    lock:{exists:true,pid:null,alive:false},
    port:{port:4187,listeners:''},
    quota:{active:false,epoch:null},
    disk:{freeBytes:100*1024**3,totalBytes:1024*1024**3},
    processes:'',
    journal:'',
    latestRun:{path:null,files:[],traces:{}}
  };
}

test('design-lab installer is portable and cannot self-trip its five-minute start cadence', () => {
  const installer = readFileSync(resolve('scripts/design-lab/install-blocker-doctor.sh'), 'utf8');
  assert.match(installer, /\$HOME\/\.local\/state\/engineering-orchestrator\/design-lab/);
  assert.match(installer, /XDG_CONFIG_HOME/);
  assert.doesNotMatch(installer, /\/home\/pablo/);
  assert.match(installer, /StartLimitIntervalSec=300/);
  assert.match(installer, /StartLimitBurst=4/);
  assert.match(installer, /RestartSec=90s/);
  assert.match(installer, /reset-failed engineering-orchestrator-design-lab\.service/);
});

test('doctor treats quota as a wait condition instead of destructive repair', () => {
  const bundle=baseBundle();
  bundle.quota={active:true,epoch:9999999999};
  const result=diagnose(bundle);
  assert.equal(result.category,'quota');
  assert.equal(result.safeAction,'wait_quota');
  assert.ok(result.confidence >= 0.9);
});

test('doctor restarts a missing scheduler', () => {
  const bundle=baseBundle();
  bundle.timers.lab=false;
  const result=diagnose(bundle);
  assert.equal(result.category,'scheduler');
  assert.equal(result.safeAction,'restart_timer');
});

test('doctor clears only a dead lock while service is inactive', () => {
  const bundle=baseBundle();
  bundle.lock={exists:true,pid:12345,alive:false};
  const result=diagnose(bundle);
  assert.equal(result.category,'stale_lock');
  assert.equal(result.safeAction,'clear_stale_lock');
});

test('doctor recognizes an orphan QA port only while service is inactive', () => {
  const bundle=baseBundle();
  bundle.port.listeners='LISTEN 0 5 127.0.0.1:4187 users:(("python3",pid=4321,fd=3))';
  const result=diagnose(bundle);
  assert.equal(result.category,'orphan_http');
  assert.equal(result.safeAction,'kill_orphan_http');
});

test('doctor never auto-deletes under disk pressure', () => {
  const bundle=baseBundle();
  bundle.disk.freeBytes=2*1024**3;
  const result=diagnose(bundle);
  assert.equal(result.category,'disk_pressure');
  assert.equal(result.safeAction,'none');
});

test('doctor can return a clean runtime repository to main but not a dirty one', () => {
  const clean=baseBundle();
  clean.git={branch:'feature/test',dirty:false,status:''};
  const cleanResult=diagnose(clean);
  assert.equal(cleanResult.safeAction,'checkout_main_if_clean');

  const dirty=baseBundle();
  dirty.git={branch:'feature/test',dirty:true,status:' M important.txt'};
  const dirtyResult=diagnose(dirty);
  assert.equal(dirtyResult.safeAction,'none');
});

test('unknown failed service requests semantic diagnosis rather than guessing a mutation', () => {
  const bundle=baseBundle();
  bundle.service={activeState:'failed',subState:'failed',result:'exit-code',execMainStatus:'1'};
  bundle.journal='application stopped with an unfamiliar invariant violation';
  const result=diagnose(bundle);
  assert.equal(result.category,'unknown_failure');
  assert.equal(result.safeAction,'none');
  assert.ok(result.confidence < 0.8);
});

test('known transient runtime failures are safely retryable', () => {
  const bundle=baseBundle();
  bundle.service={activeState:'failed',subState:'failed',result:'exit-code',execMainStatus:'1'};
  bundle.journal='browser_qa command_timeout while launching chrome';
  const result=diagnose(bundle);
  assert.equal(result.category,'transient_runtime');
  assert.equal(result.safeAction,'restart_service');
});
