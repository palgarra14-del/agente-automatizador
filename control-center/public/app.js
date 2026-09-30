const $ = (id) => document.getElementById(id);
const laneNames = {
  self: 'Agente / Automejora',
  callflow: 'Callflow',
  leadfinder: 'LeadFinder',
  'website-pilot': 'Website Pilot'
};
const activeStates = new Set(['admitted','initializing','running','pending_approval','active']);
let loading = false;
let lastData = null;

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
  if (['success','completed','active','running','queued','admitted','initializing'].includes(s)) return 'good';
  if (['failure','failed','cancelled','blocked','rejected'].includes(s)) return 'bad';
  return 'warn';
}
function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('show');
  setTimeout(() => $('toast').classList.remove('show'), 2600);
}
async function api(path, options={}) {
  const response = await fetch(path, {
    ...options,
    headers: {'content-type':'application/json', ...(options.headers || {})}
  });
  let data = {};
  try { data = await response.json(); } catch {}
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
function laneState(data, lane) {
  const issues = (data.tasks || []).filter((t) => t.request?.projectId === lane);
  const records = issues.map((t) => queueRecord(data, t.number)).filter(Boolean);
  const live = records.find((r) => activeStates.has(r.status));
  if (live) return {state:live.status, detail:'Issue #' + live.issueNumber, cls:statusClass(live.status)};
  const newest = records.sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
  if (newest) return {state:newest.status, detail:'Última #' + newest.issueNumber, cls:statusClass(newest.status)};
  return {state:'en espera', detail:issues.length ? issues.length + ' tarea(s) abierta(s)' : 'Sin trabajo pendiente', cls:'warn'};
}

function renderStats(data) {
  const records = data.queue?.records || [];
  const active = records.filter((r) => activeStates.has(r.status)).length;
  const failed = records.filter((r) => ['failed','blocked'].includes(r.status)).length;
  const latestRun = data.runs?.[0];
  const values = [
    [data.service?.active ? 'ONLINE' : 'OFFLINE','Servicio'],
    [String(active),'Activas'],
    [String(data.tasks?.length || 0),'Issues abiertas'],
    [latestRun?.status || '—','Último workflow']
  ];
  $('stats').innerHTML = values.map(([v,l]) => '<div class="stat"><div class="value">'+esc(v)+'</div><div class="label">'+esc(l)+'</div></div>').join('');
  $('heroTitle').textContent = data.service?.active ? 'El agente está accesible' : 'El servicio del agente está parado';
  $('heroSub').textContent = (data.git?.branch || 'sin rama') + ' · ' + (data.git?.commit || 'sin commit') + (data.git?.dirty ? ' · cambios locales' : '') + ' · ' + data.latencyMs + ' ms';
  $('liveDot').className = data.service?.active ? 'good' : 'bad';
  $('liveText').textContent = data.service?.active ? 'MSI online' : 'Servicio parado';
}

function renderLanes(data) {
  $('lanes').innerHTML = Object.keys(laneNames).map((lane) => {
    const s = laneState(data, lane);
    return '<article class="lane">'+
      '<div class="lane-head"><h3><span class="dot '+s.cls+'"></span>'+esc(laneNames[lane])+'</h3><span class="badge '+s.cls+'">'+esc(s.state)+'</span></div>'+
      '<p>'+esc(s.detail)+'</p>'+
      '<button data-wake="'+lane+'">Reactivar / comprobar</button>'+
    '</article>';
  }).join('');
}

function renderTasks(data) {
  const tasks = [...(data.tasks || [])].sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0,12);
  $('taskCount').textContent = String(tasks.length);
  if (!tasks.length) {
    $('tasks').innerHTML = '<div class="meta">No hay tareas abiertas del agente.</div>';
    return;
  }
  $('tasks').innerHTML = tasks.map((t) => {
    const r = queueRecord(data, t.number);
    const state = r?.status || 'pendiente';
    const approval = r?.pendingApproval;
    const approvalHtml = approval?.fingerprint
      ? '<div class="approval"><button data-approve="'+t.number+'" data-fp="'+approval.fingerprint+'">Aprobar</button><button data-reject="'+t.number+'" data-fp="'+approval.fingerprint+'">Rechazar</button></div>'
      : '';
    return '<div class="item"><div class="item-top"><strong>#'+t.number+' · '+esc(laneNames[t.request?.projectId] || t.request?.projectId)+'</strong>'+
      '<span class="badge '+statusClass(state)+'">'+esc(state)+'</span></div>'+
      '<div class="meta">'+esc(t.request?.goal || t.title)+'<br>Actualizada hace '+age(t.updatedAt)+' · <a target="_blank" href="'+esc(t.url)+'">abrir issue</a></div>'+
      approvalHtml+'</div>';
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
    return '<div class="item"><div class="item-top"><strong>Run '+r.databaseId+'</strong><span class="badge '+statusClass(state)+'">'+esc(state)+'</span></div>'+
      '<div class="meta">'+esc(r.event)+' · hace '+age(r.updatedAt)+' · <a target="_blank" href="'+esc(r.url)+'">GitHub</a></div>'+retry+'</div>';
  }).join('');
}

function render(data) {
  lastData = data;
  renderStats(data);
  renderLanes(data);
  renderTasks(data);
  renderRuns(data);
  $('processes').textContent = (data.processes || []).join('\n') || 'No hay procesos de trabajo visibles ahora mismo.';
  $('logs').textContent = (data.logs || []).slice(-70).join('\n') || 'Sin logs.';
  $('login').classList.add('hidden');
}

async function refresh() {
  if (loading || document.hidden) return;
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
  }
}

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('loginError').textContent = '';
  try {
    await api('/api/login', {method:'POST', body:JSON.stringify({pin:$('pin').value})});
    $('pin').value = '';
    await refresh();
  } catch (e) {
    $('loginError').textContent = e.message === 'unauthorized' ? 'Clave incorrecta.' : e.message;
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

$('taskForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('sendTask');
  button.disabled = true;
  button.textContent = 'Enviando…';
  try {
    const profile = $('profile').value;
    const payload = {lane:$('lane').value, goal:$('goal').value, profile};
    if (profile === 'website-build') {
      payload.businessBrief = {
        businessName:$('businessName').value,
        category:$('category').value,
        location:$('location').value,
        services:$('services').value
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
  const jump = event.target.closest('[data-jump]');
  if (jump) {
    const id = jump.dataset.jump;
    (id === 'top' ? document.body : $(id))?.scrollIntoView({behavior:'smooth',block:'start'});
    return;
  }
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
  } catch (e) {
    toast('Error: ' + e.message);
  } finally {
    if (wake) wake.disabled = false;
    if (retry) retry.disabled = false;
  }
});

$('refreshBtn').addEventListener('click', refresh);
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
refresh();
setInterval(refresh, 7000);
