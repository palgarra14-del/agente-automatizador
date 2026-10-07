const $ = (id) => document.getElementById(id);
const laneNames = {
  self: 'Agente / Automejora',
  callflow: 'Callflow',
  leadfinder: 'LeadFinder',
  'website-pilot': 'Website Pilot'
};
const activeStates = new Set(['admitted','initializing','running','pending_approval','awaiting_start_approval','awaiting_workflow_approval','execution_deferred','active']);
const terminalStates = new Set(['completed','failed','blocked','rejected','cancelled']);
const priorityNames = {high:'Alta', normal:'Normal', low:'Baja'};
const priorityOrder = {high:0, normal:1, low:2};
let loading = false;
let lastData = null;
let deferredInstallPrompt = null;
let refreshTimer = null;

function esc(value='') {
  return String(value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function age(value) {
  if (!value) return '—';
  const s = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (s < 60) return s + ' s';
  if (s < 3600) return Math.floor(s/60) + ' min';
  if (s < 86400) return Math.floor(s/3600) + ' h';
  return Math.floor(s/86400) + ' d';
}
function statusClass(value) {
  const s = String(value || '').toLowerCase();
  if (['success','completed','active','running','working','trabajando','queued','admitted','initializing','available','sleeping','standby'].includes(s)) return 'good';
  if (['failure','failed','cancelled','blocked','rejected','offline'].includes(s)) return 'bad';
  return 'warn';
}
function duration(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value < 60) return Math.ceil(value) + ' s';
  if (value < 3600) return Math.ceil(value / 60) + ' min';
  if (value < 86400) return Math.ceil(value / 3600) + ' h';
  return Math.ceil(value / 86400) + ' d';
}
function durationMs(ms) {
  const value = Math.max(0, Number(ms) || 0);
  return duration(value / 1000);
}
function pctClass(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'warn';
  if (n <= 5) return 'bad';
  if (n <= 20) return 'warn';
  return 'good';
}
function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('show');
  setTimeout(() => $('toast').classList.remove('show'), 2600);
}

function bytesToBase64url(value) {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

function base64urlToBytes(value) {
  const base64 = String(value).replace(/-/g,'+').replace(/_/g,'/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const binary = globalThis.atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function creationOptionsFromJSON(options) {
  if (globalThis.PublicKeyCredential?.parseCreationOptionsFromJSON) return globalThis.PublicKeyCredential.parseCreationOptionsFromJSON(options);
  return {
    ...options,
    challenge: base64urlToBytes(options.challenge),
    user: { ...options.user, id: base64urlToBytes(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((item) => ({ ...item, id:base64urlToBytes(item.id) }))
  };
}

function requestOptionsFromJSON(options) {
  if (globalThis.PublicKeyCredential?.parseRequestOptionsFromJSON) return globalThis.PublicKeyCredential.parseRequestOptionsFromJSON(options);
  return {
    ...options,
    challenge: base64urlToBytes(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((item) => ({ ...item, id:base64urlToBytes(item.id) }))
  };
}

function registrationResponseJSON(credential) {
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: bytesToBase64url(credential.response.clientDataJSON),
      attestationObject: bytesToBase64url(credential.response.attestationObject),
      transports: credential.response.getTransports?.() || []
    }
  };
}

function authenticationResponseJSON(credential) {
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: bytesToBase64url(credential.response.clientDataJSON),
      authenticatorData: bytesToBase64url(credential.response.authenticatorData),
      signature: bytesToBase64url(credential.response.signature),
      userHandle: credential.response.userHandle ? bytesToBase64url(credential.response.userHandle) : undefined
    }
  };
}

async function authApi(path, options={}) {
  const response = await fetch(path, {
    ...options,
    headers:{'content-type':'application/json', ...(options.headers || {})}
  });
  let data = {};
  try { data = await response.json(); } catch { /* optional JSON body */ }
  if (!response.ok) {
    const error = new Error(data.error || ('HTTP ' + response.status));
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function webAuthnSupported() {
  return Boolean(globalThis.PublicKeyCredential && navigator.credentials);
}

function renderAuthConfig(config) {
  const supported = webAuthnSupported();
  const enabled = config?.passkey?.enabled === true;
  $('passkeyLoginBtn').classList.toggle('hidden', !supported || !enabled);
  $('recoveryToggleBtn').classList.remove('hidden');
  $('loginLead').textContent = enabled && supported
    ? 'Accede con la biometría o bloqueo seguro de tu dispositivo.'
    : enabled
      ? 'Este navegador no admite la credencial biométrica registrada. Usa recuperación.'
      : 'Primera configuración: entra con recuperación y activa la huella dentro de la app.';
  if (!enabled || !supported) $('loginForm').classList.remove('hidden');
}

async function loadAuthConfig() {
  try {
    renderAuthConfig(await authApi('/api/auth/config'));
  } catch {
    $('loginLead').textContent = 'No se ha podido comprobar el acceso biométrico.';
    $('recoveryToggleBtn').classList.remove('hidden');
  }
}

async function loginWithPasskey() {
  if (!webAuthnSupported()) throw new Error('WebAuthn no disponible en este dispositivo');
  const flow = await authApi('/api/auth/passkey/options', {method:'POST',body:'{}'});
  const credential = await navigator.credentials.get({ publicKey:requestOptionsFromJSON(flow.options) });
  await authApi('/api/auth/passkey/verify', {
    method:'POST',
    body:JSON.stringify({flowId:flow.flowId,response:authenticationResponseJSON(credential)})
  });
  $('loginError').textContent = '';
  await refresh();
}

async function enrollPasskey() {
  if (!webAuthnSupported()) throw new Error('Este dispositivo no admite WebAuthn');
  const flow = await api('/api/auth/passkey/register/options', {method:'POST',body:'{}'});
  const credential = await navigator.credentials.create({ publicKey:creationOptionsFromJSON(flow.options) });
  const result = await api('/api/auth/passkey/register/verify', {
    method:'POST',
    body:JSON.stringify({flowId:flow.flowId,response:registrationResponseJSON(credential)})
  });
  if (result.recoveryKey) {
    $('recoveryKeyResult').classList.remove('hidden');
    $('recoveryKeyResult').innerHTML = '<strong>Guarda esta clave de recuperación:</strong><br><code>'+esc(result.recoveryKey)+'</code><br><span class="meta">Solo se muestra ahora. El acceso normal será biométrico.</span>';
  }
  toast('Huella / biometría registrada');
  await loadAuthConfig();
  await refresh();
}

async function logout() {
  try { await api('/api/logout', {method:'POST',body:'{}'}); } catch { /* logout is best-effort */ }
  lastData = null;
  $('login').classList.remove('hidden');
  $('logoutBtn').classList.add('hidden');
  $('loginForm').classList.add('hidden');
  await loadAuthConfig();
}

function formatBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const units = ['B','KB','MB','GB','TB'];
  let current = n;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) { current /= 1024; unit += 1; }
  return (unit >= 3 ? current.toFixed(1) : Math.round(current)) + ' ' + units[unit];
}

async function showLocalNotification(title, body) {
  if (!('Notification' in globalThis) || globalThis.Notification.permission !== 'granted') return;
  try {
    const registration = await navigator.serviceWorker?.ready;
    if (registration) return registration.showNotification(title, {body,icon:'/icon-192.png',tag:'agent-control-event'});
  } catch { /* fall back to window notification */ }
  new globalThis.Notification(title, {body});
}

function notifyTransitions(previous, current) {
  if (!previous || globalThis.Notification?.permission !== 'granted') return;
  const before = new Map((previous.queue?.records || []).map((item) => [item.issueNumber,item]));
  for (const record of current.queue?.records || []) {
    const old = before.get(record.issueNumber);
    if (!old) continue;
    if (!old.pendingApproval && record.pendingApproval) {
      showLocalNotification('Agent Control · aprobación necesaria', 'La tarea #' + record.issueNumber + ' necesita tu decisión.');
    } else if (old.status !== record.status && ['failed','blocked','rejected'].includes(record.status)) {
      showLocalNotification('Agent Control · tarea bloqueada', 'La tarea #' + record.issueNumber + ' está ' + record.status + '.');
    } else if (old.status !== record.status && record.status === 'completed') {
      showLocalNotification('Agent Control · tarea terminada', 'La tarea #' + record.issueNumber + ' ha finalizado.');
    }
  }
}

async function api(path, options={}) {
  const response = await fetch(path, {
    ...options,
    headers: {'content-type':'application/json', ...(options.headers || {})}
  });
  let data = {};
  try { data = await response.json(); } catch { /* response may intentionally have no JSON body */ }
  if (response.status === 401) {
    $('login').classList.remove('hidden');
    throw new Error('unauthorized');
  }
  if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
  return data;
}

function queueRecord(data, issueNumber) {
  return (data.queue?.records || []).find((r) => r.issueNumber === issueNumber);
}
function taskRows(data) {
  return (data.tasks || []).map((task) => {
    const record = queueRecord(data, task.number);
    const priority = task.request?.priority || record?.priority || 'normal';
    return {
      task,
      record,
      priority,
      state: record?.status || 'pendiente',
      lane: task.request?.projectId || record?.projectId || null
    };
  });
}
function rowNeedsAttention(row) {
  if (row.record?.pendingApproval) return true;
  const updatedAt = new Date(row.record?.updatedAt || row.task?.updatedAt || 0).getTime();
  const ageMs = Number.isFinite(updatedAt) ? Math.max(0, Date.now() - updatedAt) : Number.POSITIVE_INFINITY;
  const reason = String(row.record?.reason || '').toLowerCase();
  const explicitlyHuman = /human|approval|credential|auth|permission|secret|manual|config_changed|request_body_invalid|identity_or_state_changed/.test(reason);
  if (explicitlyHuman && ageMs <= 48 * 60 * 60 * 1000) return true;
  return row.state === 'blocked' && ageMs <= 6 * 60 * 60 * 1000;
}
function rowSort(left, right) {
  const attention = Number(rowNeedsAttention(right)) - Number(rowNeedsAttention(left));
  if (attention) return attention;
  const priority = (priorityOrder[left.priority] ?? 1) - (priorityOrder[right.priority] ?? 1);
  if (priority) return priority;
  const active = Number(activeStates.has(right.state)) - Number(activeStates.has(left.state));
  if (active) return active;
  return new Date(right.task.updatedAt || 0) - new Date(left.task.updatedAt || 0);
}
function renderAttention(data) {
  const items = [];
  const rows = taskRows(data);

  if (!data.service?.active) {
    items.push({severity:'bad', title:'Agente principal parado', detail:'El servicio engineering-orchestrator-inbox no está activo.', action:'top'});
  }
  if (data.queue?.error) {
    items.push({severity:'bad', title:'Cola no disponible', detail:'El Control Center no ha podido leer el estado gobernado de la cola.', action:'top'});
  }
  if (data.git?.dirty) {
    items.push({severity:'warn', title:'Cambios locales sin commit', detail:'El checkout principal tiene cambios locales; conviene revisarlos antes de mezclar más trabajo.', action:'top'});
  }

  const runners = data.runnerTelemetry || {};
  const localOnline = Number(runners.localOnline ?? runners.msiOnline ?? 0);
  const localFree = Number(runners.localFree ?? runners.msiFree ?? 0);
  if (localOnline === 0) {
    items.push({
      severity:'bad',
      title:'Sin runner local online',
      detail:'No hay capacidad local/native disponible para ejecutar trabajo pesado.',
      action:'runnerList'
    });
  } else if (localFree === 0) {
    items.push({
      severity:'warn',
      title:'Capacidad local ocupada',
      detail:localOnline + ' runner(s) local(es) online, todos ocupados.',
      action:'runnerList'
    });
  }

  for (const row of rows) {
    if (row.record?.pendingApproval) {
      items.push({
        severity:'warn',
        title:'Aprobación pendiente · #' + row.task.number,
        detail:(laneNames[row.lane] || row.lane || 'Carril') + ' · ' + (row.task.request?.goal || row.task.title || ''),
        action:'task-' + row.task.number
      });
    } else if (rowNeedsAttention(row)) {
      items.push({
        severity:'bad',
        title:(row.state === 'blocked' ? 'Tarea bloqueada' : 'Intervención requerida') + ' · #' + row.task.number,
        detail:(laneNames[row.lane] || row.lane || 'Carril') + (row.record?.reason ? ' · ' + row.record.reason : ''),
        action:'task-' + row.task.number
      });
    }
  }

  for (const provider of data.aiHealth?.providers || []) {
    if ((provider.state === 'cooldown' && provider.reasonCategory === 'auth') || provider.state === 'auth_required') {
      items.push({
        severity:'bad',
        title:provider.label + ' requiere autenticación',
        detail:'El proveedor está en cooldown por un problema de autenticación que puede requerir intervención.',
        action:'aiHealth'
      });
    } else if (provider.local && provider.state === 'offline') {
      items.push({
        severity:'bad',
        title:provider.label + ' no disponible',
        detail:'No se detecta el proceso local del proveedor.',
        action:'aiHealth'
      });
    }
  }

  const visible = items.slice(0, 10);
  $('attentionCount').textContent = String(items.length);
  $('attention').innerHTML = visible.length
    ? visible.map((item) => '<article class="attention-item '+item.severity+'">'+
        '<div><strong>'+esc(item.title)+'</strong><p>'+esc(item.detail)+'</p></div>'+
        (item.action ? '<button class="mini" data-jump="'+esc(item.action)+'">Ver</button>' : '')+
      '</article>').join('')
    : '<article class="attention-clear"><strong>Sin intervención necesaria</strong><p>El sistema no reporta bloqueos, aprobaciones pendientes ni proveedores locales caídos.</p></article>';
}
function renderQueueView(data) {
  const rows = taskRows(data)
    .filter((row) => !terminalStates.has(row.state))
    .sort(rowSort)
    .slice(0, 8);

  $('queueView').innerHTML = rows.length
    ? rows.map((row, index) => '<div class="queue-row">'+
        '<span class="queue-index">'+(index + 1)+'</span>'+
        '<div class="queue-main"><strong>'+esc(laneNames[row.lane] || row.lane || 'Sin carril')+'</strong>'+
        '<span>'+esc(row.task.request?.goal || row.task.title || '')+'</span></div>'+
        '<div class="badges"><span class="badge priority-'+esc(row.priority)+'">'+esc(priorityNames[row.priority] || row.priority)+'</span>'+
        '<span class="badge '+statusClass(row.state)+'">'+esc(row.state)+'</span></div>'+
        '<button class="mini" data-jump="task-'+row.task.number+'">#'+row.task.number+'</button>'+
      '</div>').join('')
    : '<div class="meta">No hay tareas abiertas pendientes de ejecución.</div>';
}
function laneState(data, lane) {
  const worker = (data.workActivity || []).find((item) => item.lane === lane);
  const paused = data.remoteControl?.globalPaused || (data.remoteControl?.pausedLanes || []).includes(lane);
  if (worker) {
    return {
      state: paused ? 'terminando · pausado' : 'trabajando',
      detail: worker.action + ' · proceso ' + worker.pid + ' · ' + worker.elapsed + (worker.backend ? ' · ' + worker.backend : '') + (paused ? ' · no se lanzarán nuevas ejecuciones' : ''),
      cls: paused ? 'warn' : 'good'
    };
  }
  if (paused) {
    return {
      state: 'pausado',
      detail: data.remoteControl?.globalPaused ? 'Pausa global activa' : 'Pausa manual del carril',
      cls: 'warn'
    };
  }
  const telemetry = data.laneTelemetry?.lanes?.[lane];
  if (telemetry?.current) {
    return {
      state: 'trabajando',
      detail: 'Run ' + telemetry.current.id + ' · ' + telemetry.current.status,
      cls: 'good'
    };
  }
  if (lane === 'self' && data.autonomy?.heartbeatActive && data.service?.active) {
    return {
      state: 'autónomo',
      detail: 'Vigilancia continua · heartbeat cada ' + (data.autonomy.heartbeatIntervalSeconds || 120) + ' s',
      cls: 'good'
    };
  }
  const issues = (data.tasks || []).filter((t) => t.request?.projectId === lane);
  const records = issues.map((t) => queueRecord(data, t.number)).filter(Boolean);
  const live = records.find((r) => activeStates.has(r.status));
  if (live) return {state:live.status, detail:'Issue #' + live.issueNumber, cls:statusClass(live.status)};
  const newest = records.sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
  if (newest) return {state:newest.status, detail:'Última #' + newest.issueNumber, cls:statusClass(newest.status)};
  return {state:'en espera', detail:issues.length ? issues.length + ' tarea(s) abierta(s)' : 'Sin trabajo pendiente', cls:'warn'};
}

function laneReliability(data, lane) {
  return data.laneTelemetry?.lanes?.[lane] || null;
}

function renderMission(data) {
  const health = data.controlHealth || {};
  const business = data.laneTelemetry?.business || {};
  $('missionScore').textContent = Number.isFinite(health.score) ? health.score + '/100' : '—';
  $('missionScore').className = 'mission-score ' + statusClass(
    health.state === 'strong' || health.state === 'good' ? 'success' :
      health.state === 'critical' ? 'failure' : 'warning'
  );
  const reasonLabels = {
    service_offline:'servicio parado',
    queue_unavailable:'cola no disponible',
    local_runners_offline:'runner local offline',
    local_runner_capacity_full:'runner local ocupado',
    runners_offline:'runners offline',
    runner_capacity_full:'capacidad ocupada',
    github_core_critical:'GitHub REST crítico',
    github_core_low:'GitHub REST bajo',
    control_state_unknown:'estado de control desconocido'
  };
  $('missionMeta').textContent = 'Actividad comercial 24 h: ' + (business.recentlyActive ?? 0) + '/' + (business.total ?? 3) + ' carriles · ' +
    (health.reasons?.length ? health.reasons.map((reason) => reasonLabels[reason] || reason).join(' · ') : 'sistema operativo sin alertas');

  $('missionGrid').innerHTML = Object.keys(laneNames).map((lane) => {
    const live = laneState(data, lane);
    const telemetry = laneReliability(data, lane);
    const current = telemetry?.current;
    const rate = telemetry?.successRate;
    const lastSuccess = telemetry?.lastSuccessAt;
    const runLabel = current ? ('Run ' + current.id + ' · ' + current.status) :
      (telemetry?.latest ? ('Último run ' + telemetry.latest.id + ' · ' + (telemetry.latest.conclusion || telemetry.latest.status)) : 'Sin runs recientes');
    const paused = data.remoteControl?.globalPaused || (data.remoteControl?.pausedLanes || []).includes(lane);
    const details = [
      Number.isFinite(rate) ? 'Éxito reciente ' + rate + '%' : null,
      lastSuccess ? 'Último OK hace ' + age(lastSuccess) : null,
      Number.isFinite(telemetry?.avgSuccessDurationMs) ? 'Media ' + durationMs(telemetry.avgSuccessDurationMs) : null,
      telemetry?.recentFailures ? telemetry.recentFailures + ' fallo(s) en ventana' : null
    ].filter(Boolean).join(' · ');
    return '<article class="mission-lane">'+
      '<div class="item-top"><strong>'+esc(laneNames[lane])+'</strong><span class="badge '+live.cls+'">'+esc(live.state)+'</span></div>'+
      '<div class="mission-run">'+esc(runLabel)+'</div>'+
      '<div class="meta">'+esc(live.detail)+'</div>'+
      '<div class="mission-kpis">'+esc(details || 'Aún sin muestra suficiente')+'</div>'+
      (paused
        ? '<button class="mini mission-wake" disabled>Pausado</button>'
        : '<button class="mini mission-wake" data-wake="'+lane+'">Reactivar</button>')+
    '</article>';
  }).join('');
}

function renderInfrastructure(data) {
  const runners = data.runnerTelemetry || {};
  const rows = runners.runners || [];
  const localOnline = runners.localOnline ?? runners.msiOnline ?? 0;
  const localBusy = runners.localBusy ?? runners.msiBusy ?? 0;
  const localFree = runners.localFree ?? runners.msiFree ?? 0;
  $('runnerSummary').innerHTML =
    '<div class="infra-kpi"><strong>'+esc(String(localOnline))+'</strong><span>Locales online</span></div>'+
    '<div class="infra-kpi"><strong>'+esc(String(localBusy))+'</strong><span>Locales ocupados</span></div>'+
    '<div class="infra-kpi"><strong>'+esc(String(localFree))+'</strong><span>Locales libres</span></div>';
  $('runnerList').innerHTML = rows.length ? rows.map((runner) =>
    '<div class="runner-row"><span class="dot '+(runner.status === 'online' ? 'good' : 'bad')+'"></span>'+
    '<strong>'+esc(runner.name || 'runner')+'</strong>'+
    '<span>'+esc(runner.busy ? 'ocupado' : (runner.status === 'online' ? 'libre' : runner.status))+'</span></div>'
  ).join('') : '<div class="meta">Telemetría de runners no disponible.</div>';

  const rate = data.githubRateLimit || {};
  const cards = [['REST / core',rate.core],['GraphQL',rate.graphql]];
  $('githubBudget').innerHTML = cards.map(([label,value]) => {
    if (!value) return '<div class="budget-row"><div><strong>'+esc(label)+'</strong><span>sin datos</span></div></div>';
    return '<div class="budget-row"><div><strong>'+esc(label)+'</strong><span>'+esc(String(value.remaining))+' / '+esc(String(value.limit))+' restantes</span></div>'+
      '<div class="budget-meter"><i class="'+pctClass(value.remainingPercent)+'" style="width:'+Math.max(2,value.remainingPercent)+'%"></i></div>'+
      '<b class="'+pctClass(value.remainingPercent)+'">'+esc(String(value.remainingPercent))+'%</b>'+
      (Number.isFinite(value.resetInSeconds) ? '<small>reset '+duration(value.resetInSeconds)+'</small>' : '')+
      '</div>';
  }).join('');
  const freshness = data.telemetry || {};
  const ages = [freshness.runsAgeMs,freshness.runnersAgeMs,freshness.rateLimitAgeMs].filter(Number.isFinite);
  $('infraFreshness').textContent = ages.length ? 'Telemetría cacheada hace ' + durationMs(Math.max(...ages)) : 'Telemetría en vivo';
}

function renderRemoteControl(data) {
  const control = data.remoteControl || {};
  const known = control.known !== false;
  const paused = control.pausedLanes || [];
  const globalPaused = control.globalPaused === true;
  const partial = known && !globalPaused && paused.length > 0;
  $('controlMode').textContent = !known ? 'DESCONOCIDO' : globalPaused ? 'PAUSADO' : (partial ? 'PARCIAL' : 'AUTÓNOMO');
  $('controlMode').className = 'badge ' + (!known ? 'bad' : (globalPaused || partial ? 'warn' : 'good'));
  $('controlNote').textContent = !known
    ? 'GitHub no ha podido confirmar el estado de pausa. Agent Control no asumirá que la autonomía está activa.'
    : globalPaused
      ? 'No se lanzarán nuevas ejecuciones. Los trabajos que ya estaban en curso pueden terminar de forma segura.'
      : (partial
        ? 'Carriles pausados: ' + paused.map((lane) => laneNames[lane] || lane).join(', ') + '. El resto sigue autónomo.'
        : 'Todos los carriles pueden trabajar de forma autónoma. Puedes pausar sin matar tareas a medias.');
  $('pauseAllBtn').disabled = !known || globalPaused;
  $('resumeAllBtn').disabled = !known || (!globalPaused && paused.length === 0);
}

function renderNightMode(data) {
  const mode = data.nightMode || {};
  const active = mode.active === true;
  $('nightModeBadge').textContent = active ? 'NOCHE ACTIVA' : 'NOCHE OFF';
  $('nightModeBadge').className = 'badge ' + (active ? 'good' : 'warn');
  $('nightModeNote').textContent = active
    ? 'Suspensión bloqueada. La sesión queda bloqueada y la pantalla apagada hasta que salgas del modo noche.'
    : 'Solo se activa cuando tú lo ordenas. Mantiene el equipo despierto, bloquea la sesión y apaga la pantalla. No cierra aplicaciones.';
  $('activateNightModeBtn').disabled = active;
  $('deactivateNightModeBtn').disabled = !active;
  $('nightModeQuickBtn').textContent = active ? 'Salir modo noche' : 'Modo noche';
  $('nightModeQuickBtn').className = active ? 'ghost' : 'primary';
}

function renderStats(data) {
  const records = data.queue?.records || [];
  const active = records.filter((r) => activeStates.has(r.status)).length;
  const runners = data.runnerTelemetry || {};
  const business = data.laneTelemetry?.business || {};
  const corePct = data.githubRateLimit?.core?.remainingPercent;
  const control = data.remoteControl || {};
  const known = control.known !== false;
  const operatorPaused = control.globalPaused === true;
  const partial = known && !operatorPaused && (control.pausedLanes || []).length > 0;
  const autonomous = known && data.service?.active && data.autonomy?.heartbeatActive && Number(runners.localOnline ?? runners.msiOnline ?? 0) > 0 && !operatorPaused;
  const agentLabel = !known ? 'DESCONOCIDO' : operatorPaused ? 'PAUSADO' : partial ? 'PARCIAL' : autonomous ? 'AUTÓNOMO' : (data.service?.active ? 'ONLINE' : 'OFFLINE');
  const values = [
    [agentLabel,'Agente'],
    [String(runners.localOnline ?? runners.msiOnline ?? '—'),'Runners locales'],
    [(business.recentlyActive ?? '—') + '/' + (business.total ?? 3),'Actividad 24 h'],
    [Number.isFinite(corePct) ? corePct + '%' : '—','GitHub REST']
  ];
  $('stats').innerHTML = values.map(([v,l]) => '<div class="stat"><div class="value">'+esc(v)+'</div><div class="label">'+esc(l)+'</div></div>').join('');
  $('heroTitle').textContent = !known
    ? 'Estado de autonomía sin confirmar'
    : operatorPaused
      ? 'Autonomía pausada por ti'
      : partial
        ? 'Autonomía parcial'
        : (autonomous
          ? 'Agente autónomo activo'
          : (data.service?.active ? 'Agente online, autonomía degradada' : 'El servicio del agente está parado'));
  $('heroSub').textContent = (data.git?.branch || 'sin rama') + ' · ' + (data.git?.commit || 'sin commit') + (data.git?.dirty ? ' · cambios locales' : '') +
    ' · heartbeat ' + (data.autonomy?.heartbeatActive ? 'cada ' + (data.autonomy.heartbeatIntervalSeconds || 120) + ' s' : 'no disponible') +
    ' · ' + active + ' tarea(s) activas';
  $('liveDot').className = !known ? 'bad' : (autonomous ? 'good' : (data.service?.active ? 'warn' : 'bad'));
  $('liveText').textContent = !known ? 'Control no confirmado' : operatorPaused ? 'Pausa manual activa' : partial ? 'Autonomía parcial' : (autonomous ? 'Autonomía activa' : (data.service?.active ? 'Online con vigilancia degradada' : 'Servicio parado'));
}

function renderLanes(data) {
  const controlKnown = data.remoteControl?.known !== false;
  const globalPaused = data.remoteControl?.globalPaused === true;
  const pausedLanes = new Set(data.remoteControl?.pausedLanes || []);
  $('lanes').innerHTML = Object.keys(laneNames).map((lane) => {
    const s = laneState(data, lane);
    const lanePaused = pausedLanes.has(lane);
    const pauseButton = !controlKnown
      ? '<button class="ghost" disabled>Control sin confirmar</button>'
      : globalPaused
        ? '<button class="ghost" disabled>Pausa global activa</button>'
        : (lanePaused
          ? '<button class="primary" data-lane-pause="'+lane+'" data-paused="false">Reanudar carril</button>'
          : '<button class="ghost" data-lane-pause="'+lane+'" data-paused="true">Pausar carril</button>');
    const wakeButton = !controlKnown || globalPaused || lanePaused
      ? '<button disabled>Reactivar / comprobar · '+(!controlKnown ? 'estado desconocido' : 'pausado')+'</button>'
      : '<button data-wake="'+lane+'">Reactivar / comprobar</button>';
    return '<article class="lane">'+
      '<div class="lane-head"><h3><span class="dot '+s.cls+'"></span>'+esc(laneNames[lane])+'</h3><span class="badge '+s.cls+'">'+esc(s.state)+'</span></div>'+
      '<p>'+esc(s.detail)+'</p>'+
      '<div class="lane-actions">'+wakeButton+pauseButton+'</div>'+
    '</article>';
  }).join('');
}

function renderHostResources(data) {
  const resources = data.hostResources || {};
  const memory = resources.memory || {};
  const cpu = resources.cpu || {};
  const battery = resources.battery;
  const disk = resources.disk;
  const cards = [
    ['RAM', Number.isFinite(memory.usedPercent) ? memory.usedPercent + '%' : '—', formatBytes(memory.usedBytes) + ' / ' + formatBytes(memory.totalBytes)],
    ['CPU', Number.isFinite(cpu.loadPercent) ? cpu.loadPercent + '%' : '—', 'carga 1 min · ' + (cpu.cores || '—') + ' núcleos'],
    ['Batería', battery && Number.isFinite(battery.percent) ? battery.percent + '%' : '—', battery?.status || 'sin telemetría'],
    ['Temperatura', Number.isFinite(resources.temperatureC) ? resources.temperatureC + ' °C' : '—', disk && Number.isFinite(disk.usedPercent) ? 'Disco ' + disk.usedPercent + '% usado' : 'sin temperatura']
  ];
  $('hostResources').innerHTML = cards.map(([label,value,detail]) =>
    '<div class="resource-item"><span>'+esc(label)+'</span><strong>'+esc(value)+'</strong><small>'+esc(detail)+'</small></div>'
  ).join('');
}

function renderAiHealth(data) {
  const health = data.aiHealth || {};
  const providers = health.providers || [];
  const last = health.lastModel;
  const cards = [];
  if (last) {
    cards.push('<article class="health-item">'+
      '<div class="item-top"><strong>Último modelo registrado</strong><span class="badge '+statusClass(last.success ? 'success' : 'failure')+'">'+(last.success ? 'OK' : 'FALLO')+'</span></div>'+
      '<div class="meta">'+esc(last.candidate)+' · '+esc(last.provider)+(last.role ? ' · '+esc(last.role) : '')+
      '<br>Hace '+age(last.recordedAt)+(last.model ? ' · '+esc(last.model) : '')+'</div></article>');
  }
  for (const provider of providers) {
    const detail = provider.state === 'cooldown'
      ? 'Motivo: '+esc(provider.reasonCategory || 'unknown')+' · reintento en '+duration(provider.retryInSeconds)
      : provider.id === 'codex'
        ? (provider.authenticated ? 'CLI autenticado con ChatGPT · listo para routing' : (provider.installed ? 'CLI instalado · requiere autenticación' : 'CLI no detectado'))
        : provider.id === 'ollama'
          ? (provider.state === 'sleeping' ? 'En reposo para ahorrar recursos' : provider.state === 'standby' ? 'Servicio listo · sin modelo cargado' : 'Modelo(s) cargados: '+esc(String(provider.loadedModels || 0)))
          : provider.id === 'antigravity'
            ? (provider.installed ? 'CLI detectado · disponible para routing salvo cooldown' : 'CLI no detectado')
            : (provider.local ? (provider.processActive ? 'Proceso local activo' : 'Instalado y disponible bajo demanda') : 'Elegible para routing');
    const controls = provider.id === 'ollama'
      ? '<div class="approval"><button data-ollama="'+(provider.state === 'sleeping' ? 'wake' : 'sleep')+'">'+(provider.state === 'sleeping' ? 'Despertar Ollama' : 'Dormir Ollama')+'</button></div>'
      : '';
    cards.push('<article class="health-item">'+
      '<div class="item-top"><strong>'+esc(provider.label)+'</strong><span class="badge '+statusClass(provider.state)+'">'+esc(provider.state)+'</span></div>'+
      '<div class="meta">'+esc(provider.kind)+'<br>'+detail+'</div>'+controls+'</article>');
  }
  $('aiHealth').innerHTML = cards.join('') || '<div class="meta">Sin telemetría de modelos disponible.</div>';
}

function renderOperations(data) {
  const operations = new Map((data.cloudOperations || []).map((item) => [item.lane, item]));
  $('operations').innerHTML = Object.keys(laneNames).map((lane) => {
    const op = operations.get(lane);
    if (!op?.worker) {
      return '<article class="operation-item">'+
        '<div class="item-top"><strong>'+esc(laneNames[lane])+'</strong><span class="badge warn">en espera</span></div>'+
        '<div class="meta">Sin worker cloud ejecutándose ahora mismo.</div>'+
      '</article>';
    }
    const current = op.current;
    const latest = op.latest;
    const execution = current?.execution;
    const model = execution?.modelCandidate || execution?.model || null;
    const task = current?.issueNumber ? (data.tasks || []).find((item) => item.number === current.issueNumber) : null;
    const slot = execution?.providerSlot;
    const details = [
      op.worker.action ? 'Worker: ' + op.worker.action : null,
      op.worker.elapsed ? 'Tiempo: ' + op.worker.elapsed : null,
      op.worker.backend ? 'Backend vivo: ' + op.worker.backend : (op.worker.modelGatewayActive ? 'Backend vivo: model-gateway' : null),
      current?.issueNumber ? 'Issue #' + current.issueNumber : null,
      execution?.stepId ? 'Paso: ' + execution.stepId : null,
      execution?.specialist ? 'Especialista: ' + execution.specialist : null,
      model ? 'IA: ' + model + (execution?.modelProvider ? ' (' + execution.modelProvider + ')' : '') : null,
      execution?.resourceClass ? 'Recurso: ' + execution.resourceClass : null,
      slot?.provider && Number.isInteger(slot.slot) && Number.isInteger(slot.limit)
        ? 'Slot: ' + slot.provider + ' ' + (slot.slot + 1) + '/' + slot.limit
        : null,
      Number.isFinite(execution?.routingScore) ? 'Routing: ' + execution.routingScore.toFixed(3) : null,
      execution ? 'Intentos: ' + execution.attempts + (execution.maxAttempts ? '/' + execution.maxAttempts : '') : null
    ].filter(Boolean);
    const fallback = execution?.fallbackCategories?.length
      ? '<div class="fallback-line">Fallback: '+esc(execution.fallbackCategories.join(', '))+'</div>'
      : (execution?.usedFallback ? '<div class="fallback-line">Fallback activo/usado</div>' : '');
    const goal = current?.goal || task?.request?.goal || null;
    const issueLink = task?.url ? ' · <a target="_blank" href="'+esc(task.url)+'">abrir issue</a>' : '';
    const state = current?.status || 'trabajando';
    const autonomousLine = !current
      ? (op.loading
        ? '<div class="operation-goal">Leyendo estado cloud del carril…</div>'
        : '<div class="operation-goal">Trabajo autónomo/de carril sin issue activo.</div>')
      : '';
    const latestLine = !current && !op.loading && latest?.issueNumber
      ? '<div class="meta">Último issue registrado: #'+esc(latest.issueNumber)+' · '+esc(latest.status)+' · hace '+age(latest.updatedAt)+'</div>'
      : '';
    return '<article class="operation-item">'+
      '<div class="item-top"><strong>'+esc(laneNames[lane])+'</strong><span class="badge '+statusClass(state)+'">'+esc(state)+'</span></div>'+
      (goal ? '<div class="operation-goal">'+esc(goal)+issueLink+'</div>' : autonomousLine)+
      '<div class="operation-details">'+details.map(esc).join(' · ')+'</div>'+
      latestLine+
      fallback+
      (op.error ? '<div class="fallback-line">Estado cloud no disponible temporalmente.</div>' : '')+
    '</article>';
  }).join('');
}

function renderTasks(data) {
  const laneFilter = $('taskLaneFilter')?.value || 'all';
  const viewFilter = $('taskViewFilter')?.value || 'all';
  let rows = taskRows(data).sort(rowSort);
  if (laneFilter !== 'all') rows = rows.filter((row) => row.lane === laneFilter);
  if (viewFilter === 'attention') rows = rows.filter(rowNeedsAttention);
  if (viewFilter === 'active') rows = rows.filter((row) => row.record && !terminalStates.has(row.state));
  if (viewFilter === 'historical') rows = rows.filter((row) => !row.record || terminalStates.has(row.state));
  if (viewFilter === 'high') rows = rows.filter((row) => row.priority === 'high');
  const totalMatching = rows.length;
  rows = rows.slice(0, 16);

  const summary = data.taskSummary || {};
  $('taskCount').textContent = totalMatching + ' / ' + (summary.openGithub ?? totalMatching);
  $('taskSummary').innerHTML =
    '<span><strong>'+esc(String(summary.active ?? '—'))+'</strong> activas</span>'+
    '<span><strong>'+esc(String(summary.approvals ?? '—'))+'</strong> aprobación</span>'+
    '<span><strong>'+esc(String(summary.historical ?? '—'))+'</strong> históricas abiertas</span>';
  if (!rows.length) {
    $('tasks').innerHTML = '<div class="meta">No hay tareas que coincidan con este filtro.</div>';
    return;
  }
  $('tasks').innerHTML = rows.map((row) => {
    const t = row.task;
    const r = row.record;
    const state = row.state;
    const priority = row.priority;
    const execution = r?.execution;
    const model = execution?.modelCandidate || execution?.model || null;
    const slot = execution?.providerSlot;
    const slotLabel = slot?.provider && Number.isInteger(slot?.slot) && Number.isInteger(slot?.limit)
      ? 'Slot: ' + slot.provider + ' ' + (slot.slot + 1) + '/' + slot.limit
      : null;
    const executionBits = [
      execution?.stepId ? 'Paso: ' + execution.stepId : null,
      execution?.specialist ? 'Especialista: ' + execution.specialist : null,
      model ? 'IA: ' + model + (execution?.modelProvider ? ' (' + execution.modelProvider + ')' : '') : null,
      execution?.resourceClass ? 'Recurso: ' + execution.resourceClass : null,
      slotLabel,
      Number.isFinite(execution?.routingScore) ? 'Routing: ' + execution.routingScore.toFixed(3) : null,
      execution ? 'Intentos: ' + execution.attempts + (execution.maxAttempts ? '/' + execution.maxAttempts : '') : null,
      execution?.fallbackCount ? 'Fallbacks: ' + execution.fallbackCount : null,
      execution?.fallbackCategories?.length ? 'Motivos: ' + execution.fallbackCategories.join(', ') : null,
      execution?.usedFallback ? 'fallback activo/usado' : null
    ].filter(Boolean);
    const executionHtml = executionBits.length
      ? '<div class="execution-line">' + executionBits.map(esc).join(' · ') + '</div>'
      : '';
    const approval = r?.pendingApproval;
    const approvalHtml = approval?.fingerprint
      ? '<div class="approval"><button data-approve="'+t.number+'" data-fp="'+approval.fingerprint+'">Aprobar</button><button data-reject="'+t.number+'" data-fp="'+approval.fingerprint+'">Rechazar</button></div>'
      : '';
    const cancelHtml = r?.workflowId && !terminalStates.has(state)
      ? '<div class="approval"><button class="danger" data-cancel-workflow="'+esc(r.workflowId)+'" data-cancel-issue="'+t.number+'">Cancelar tarea</button></div>'
      : '';
    return '<div class="item" id="task-'+t.number+'"><div class="item-top"><strong>#'+t.number+' · '+esc(laneNames[row.lane] || row.lane || 'Sin carril')+'</strong>'+
      '<div class="badges"><span class="badge priority-'+esc(priority)+'">'+esc(priorityNames[priority] || priority)+'</span><span class="badge '+statusClass(state)+'">'+esc(state)+'</span></div></div>'+
      '<div class="meta">'+esc(t.request?.goal || t.title)+'<br>Actualizada hace '+age(t.updatedAt)+' · <a target="_blank" href="'+esc(t.url)+'">abrir issue</a>'+
      (r?.reason ? '<br>Motivo: '+esc(r.reason) : '')+'</div>'+
      executionHtml+approvalHtml+cancelHtml+'</div>';
  }).join('');
}

function renderRuns(data) {
  const runs = (data.runs || []).slice(0,10);
  if (!runs.length) {
    $('runs').innerHTML = '<div class="meta">No se han podido cargar workflows.</div>';
    return;
  }
  $('runs').innerHTML = runs.map((r) => {
    const state = r.status === 'completed' ? (r.conclusion || r.status) : r.status;
    const retry = ['failure','cancelled','timed_out'].includes(r.conclusion)
      ? '<button class="mini" data-retry="'+r.databaseId+'">Reintentar fallos</button>' : '';
    const title = r.displayTitle || ('Run ' + r.databaseId);
    return '<div class="item"><div class="item-top"><strong>'+esc(title)+'</strong><span class="badge '+statusClass(state)+'">'+esc(state)+'</span></div>'+
      '<div class="meta">#'+esc(String(r.databaseId))+' · '+esc(r.event)+' · hace '+age(r.updatedAt)+' · <a target="_blank" href="'+esc(r.url)+'">GitHub</a></div>'+retry+'</div>';
  }).join('');
}

function render(data) {
  const previous = lastData;
  lastData = data;
  notifyTransitions(previous, data);
  renderStats(data);
  renderRemoteControl(data);
  renderNightMode(data);
  renderMission(data);
  renderInfrastructure(data);
  renderHostResources(data);
  renderAttention(data);
  renderQueueView(data);
  renderLanes(data);
  renderAiHealth(data);
  renderOperations(data);
  renderTasks(data);
  renderRuns(data);
  $('processes').textContent = (data.processes || []).join('\n') || 'No hay procesos de trabajo visibles ahora mismo.';
  $('logs').textContent = (data.logs || []).slice(-70).join('\n') || 'Sin logs.';
  const passkey = data.auth || {};
  $('passkeyStatus').textContent = passkey.enabled
    ? passkey.count + ' credencial(es) biométrica(s) registrada(s). El acceso normal usa el autenticador seguro del dispositivo.'
    : 'Aún no hay biometría registrada. Actívala en este dispositivo.';
  $('login').classList.add('hidden');
  $('logoutBtn').classList.remove('hidden');
}

function refreshDelay(data) {
  const records = data?.queue?.records || [];
  const active = records.some((record) => activeStates.has(record.status) || record.pendingApproval);
  return active ? 7000 : 20000;
}

function scheduleRefresh(delay) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, delay);
}

async function refresh() {
  if (loading || document.hidden) {
    scheduleRefresh(20000);
    return;
  }
  loading = true;
  try {
    render(await api('/api/status'));
  } catch (e) {
    if (e.message !== 'unauthorized') {
      $('liveDot').className = 'bad';
      $('liveText').textContent = 'Sin conexión';
    }
  } finally {
    loading = false;
    scheduleRefresh(refreshDelay(lastData));
  }
}

$('passkeyLoginBtn').addEventListener('click', async () => {
  $('loginError').textContent = '';
  $('passkeyLoginBtn').disabled = true;
  try { await loginWithPasskey(); }
  catch (e) { $('loginError').textContent = e.data?.retryAfterSeconds ? 'Demasiados intentos. Reintenta en '+e.data.retryAfterSeconds+' s.' : 'No se pudo validar la biometría.'; }
  finally { $('passkeyLoginBtn').disabled = false; }
});

$('recoveryToggleBtn').addEventListener('click', () => {
  $('loginForm').classList.toggle('hidden');
});

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('loginError').textContent = '';
  try {
    await authApi('/api/login', {method:'POST', body:JSON.stringify({pin:$('pin').value})});
    $('pin').value = '';
    await refresh();
  } catch (e) {
    $('loginError').textContent = e.data?.retryAfterSeconds
      ? 'Acceso temporalmente limitado. Reintenta en '+e.data.retryAfterSeconds+' s.'
      : 'Clave de recuperación incorrecta.';
  }
});

function syncTaskMode() {
  const website = $('profile').value === 'website-build';
  $('briefFields').classList.toggle('hidden', !website);
  if (website) $('lane').value = 'website-pilot';
  $('taskHint').textContent = website
    ? 'Website Pilot recibirá el brief y la tarea como una solicitud de creación de web.'
    : 'Se enviará a la cola gobernada del agente y quedará registrada.';
}
$('profile').addEventListener('change', syncTaskMode);
syncTaskMode();

for (const id of ['taskLaneFilter','taskViewFilter']) {
  $(id)?.addEventListener('change', () => {
    if (lastData) renderTasks(lastData);
  });
}

$('taskForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('sendTask');
  button.disabled = true;
  button.textContent = 'Enviando…';
  try {
    const profile = $('profile').value;
    const payload = {lane:$('lane').value, goal:$('goal').value, profile, priority:$('priority').value};
    if (profile === 'website-build') {
      payload.businessBrief = {
        businessName:$('businessName').value,
        category:$('category').value,
        location:$('location').value,
        services:$('services').value,
        phone:$('businessPhone').value,
        whatsapp:$('businessWhatsapp').value,
        currentWebsite:$('currentWebsite').value,
        bookingUrl:$('bookingUrl').value,
        instagramUrl:$('instagramUrl').value,
        address:$('businessAddress').value
      };
    }
    const result = await api('/api/task', {
      method:'POST',
      body:JSON.stringify(payload)
    });
    $('taskResult').classList.remove('hidden');
    $('taskResult').innerHTML = 'Tarea #' + esc(result.issueNumber || '—') + ' enviada a <strong>' + esc(laneNames[result.lane]) + '</strong>. '+
      (result.url ? '<a target="_blank" href="'+esc(result.url)+'">Ver registro</a>' : '');
    $('goal').value = '';
    toast('Tarea enviada al agente');
    setTimeout(refresh, 1200);
  } catch (e) {
    toast('Error: ' + e.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Enviar tarea';
  }
});

document.addEventListener('click', async (event) => {
  const wake = event.target.closest('[data-wake]');
  const retry = event.target.closest('[data-retry]');
  const approve = event.target.closest('[data-approve]');
  const reject = event.target.closest('[data-reject]');
  const cancel = event.target.closest('[data-cancel-workflow]');
  const lanePause = event.target.closest('[data-lane-pause]');
  const ollama = event.target.closest('[data-ollama]');
  const jump = event.target.closest('[data-jump]');
  if (jump) {
    const id = jump.dataset.jump;
    if (id?.startsWith('task-') && !$(id) && lastData) {
      $('taskLaneFilter').value = 'all';
      $('taskViewFilter').value = 'all';
      renderTasks(lastData);
    }
    (id === 'top' ? document.body : $(id))?.scrollIntoView({behavior:'smooth',block:'center'});
    return;
  }
  if (cancel && !globalThis.confirm('Cancelar esta tarea? El workflow se detendra de forma gobernada y quedara registrado.')) return;
  try {
    if (wake) {
      wake.disabled = true;
      await api('/api/wake',{method:'POST',body:JSON.stringify({lane:wake.dataset.wake})});
      toast('Carril reactivado');
      setTimeout(refresh, 1500);
    }
    if (retry) {
      retry.disabled = true;
      await api('/api/retry',{method:'POST',body:JSON.stringify({runId:Number(retry.dataset.retry)})});
      toast('Reintento solicitado');
      setTimeout(refresh, 1500);
    }
    if (approve || reject) {
      const el = approve || reject;
      const decision = approve ? 'approve' : 'reject';
      await api('/api/approve',{method:'POST',body:JSON.stringify({
        issueNumber:Number(el.dataset.approve || el.dataset.reject),
        fingerprint:el.dataset.fp,
        decision
      })});
      toast(decision === 'approve' ? 'Aprobación enviada' : 'Rechazo enviado');
      setTimeout(refresh, 1200);
    }
    if (cancel) {
      cancel.disabled = true;
      await api('/api/cancel-task',{method:'POST',body:JSON.stringify({workflowId:cancel.dataset.cancelWorkflow})});
      toast('Cancelacion solicitada para la tarea #' + cancel.dataset.cancelIssue);
      setTimeout(refresh, 1000);
    }
    if (lanePause) {
      lanePause.disabled = true;
      const paused = lanePause.dataset.paused === 'true';
      await api('/api/control/lane',{method:'POST',body:JSON.stringify({lane:lanePause.dataset.lanePause,paused})});
      toast(paused ? 'Carril pausado de forma segura' : 'Carril reanudado');
      setTimeout(refresh, 700);
    }
    if (ollama) {
      ollama.disabled = true;
      const enabled = ollama.dataset.ollama === 'wake';
      await api('/api/control/ollama',{method:'POST',body:JSON.stringify({enabled})});
      toast(enabled ? 'Ollama despertado' : 'Ollama en reposo');
      setTimeout(refresh, 700);
    }
  } catch (e) {
    toast('Error: ' + e.message);
  } finally {
    if (wake) wake.disabled = false;
    if (retry) retry.disabled = false;
    if (cancel) cancel.disabled = false;
    if (lanePause) lanePause.disabled = false;
    if (ollama) ollama.disabled = false;
  }
});

$('pinChangeForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const pin = $('newPin').value;
  const confirmPin = $('confirmPin').value;
  if (pin !== confirmPin) {
    toast('Los PIN no coinciden');
    return;
  }
  const button = $('changePinBtn');
  button.disabled = true;
  button.textContent = 'Cambiando…';
  try {
    await api('/api/change-pin', {method:'POST', body:JSON.stringify({pin})});
    $('newPin').value = '';
    $('confirmPin').value = '';
    toast('Clave de recuperación actualizada');
  } catch (e) {
    toast('Error: ' + e.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Cambiar recuperación';
  }
});

$('refreshBtn').addEventListener('click', refresh);

function standaloneMode() {
  return globalThis.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

function syncInstallButtons() {
  const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const shouldShow = !standaloneMode() && (Boolean(deferredInstallPrompt) || isiOS);
  $('installAppBtn')?.classList.toggle('hidden', !shouldShow);
  $('mobileInstallBtn')?.classList.toggle('hidden', standaloneMode());
}

globalThis.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  syncInstallButtons();
});

globalThis.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  syncInstallButtons();
  toast('Agent Control instalado');
});

async function installApp() {
  if (deferredInstallPrompt) {
    const prompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice?.outcome !== 'accepted') deferredInstallPrompt = prompt;
    syncInstallButtons();
    return;
  }
  const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  toast(isiOS ? 'Safari: Compartir → Añadir a pantalla de inicio' : 'Usa el menú del navegador → Instalar app');
}
$('installAppBtn')?.addEventListener('click', installApp);
$('mobileInstallBtn')?.addEventListener('click', installApp);
syncInstallButtons();

$('notifyBtn')?.addEventListener('click', async () => {
  if (!('Notification' in globalThis)) return toast('Este navegador no admite notificaciones');
  const permission = await globalThis.Notification.requestPermission();
  $('notifyBtn').textContent = permission === 'granted' ? 'Notificaciones activas' : 'Activar notificaciones';
  toast(permission === 'granted' ? 'Avisos locales activados' : 'Notificaciones no autorizadas');
});

$('enrollPasskeyBtn').addEventListener('click', async () => {
  const button = $('enrollPasskeyBtn');
  button.disabled = true;
  try { await enrollPasskey(); }
  catch (e) { toast('No se pudo registrar la biometría: ' + e.message); }
  finally { button.disabled = false; }
});

$('logoutBtn').addEventListener('click', logout);
$('logoutSecurityBtn').addEventListener('click', logout);

$('pauseAllBtn').addEventListener('click', async () => {
  if (!globalThis.confirm('Pausar nuevas ejecuciones? Los trabajos que ya estén en curso podrán terminar de forma segura.')) return;
  const button = $('pauseAllBtn');
  button.disabled = true;
  try {
    await api('/api/control/global', {method:'POST', body:JSON.stringify({paused:true})});
    toast('Autonomía pausada');
    await refresh();
  } catch (e) {
    toast('Error: ' + e.message);
  } finally {
    button.disabled = false;
  }
});

$('resumeAllBtn').addEventListener('click', async () => {
  const button = $('resumeAllBtn');
  button.disabled = true;
  try {
    await api('/api/control/global', {method:'POST', body:JSON.stringify({paused:false})});
    for (const lane of (lastData?.remoteControl?.pausedLanes || [])) {
      await api('/api/control/lane', {method:'POST', body:JSON.stringify({lane,paused:false})});
    }
    toast('Autonomía reanudada');
    setTimeout(refresh, 500);
  } catch (e) {
    toast('Error: ' + e.message);
  } finally {
    button.disabled = false;
  }
});

$('nightModeQuickBtn').addEventListener('click', () => {
  const active = lastData?.nightMode?.active === true;
  $(active ? 'deactivateNightModeBtn' : 'activateNightModeBtn').click();
});

$('activateNightModeBtn').addEventListener('click', async () => {
  if (!globalThis.confirm('¿Activar modo noche? Se bloqueará la sesión y se apagará la pantalla, pero el agente seguirá trabajando. No se cerrarán tus aplicaciones.')) return;
  const button = $('activateNightModeBtn');
  button.disabled = true;
  try {
    await api('/api/control/night-mode', {method:'POST', body:JSON.stringify({enabled:true})});
    toast('Modo noche activado');
  } catch (e) {
    toast('Error: ' + e.message);
  } finally {
    setTimeout(refresh, 700);
  }
});

$('deactivateNightModeBtn').addEventListener('click', async () => {
  const button = $('deactivateNightModeBtn');
  button.disabled = true;
  try {
    await api('/api/control/night-mode', {method:'POST', body:JSON.stringify({enabled:false})});
    toast('Modo noche desactivado');
  } catch (e) {
    toast('Error: ' + e.message);
  } finally {
    setTimeout(refresh, 700);
  }
});

$('restartServiceBtn').addEventListener('click', async () => {
  const button = $('restartServiceBtn');
  button.disabled = true;
  button.textContent = 'Reiniciando…';
  try {
    const result = await api('/api/restart-service', {method:'POST', body:'{}'});
    toast(result.active ? 'Agente reiniciado y activo' : 'Reinicio solicitado');
    setTimeout(refresh, 1800);
  } catch (e) {
    toast('Error: ' + e.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Reiniciar agente';
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
loadAuthConfig();
refresh();
