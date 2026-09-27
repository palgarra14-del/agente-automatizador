function iso(value) {
  if (Number.isNaN(Date.parse(value))) throw new Error('university_health_time_invalid');
  return new Date(value).toISOString();
}

export function healthyAcademicMonitorState(capturedAt) {
  return {
    version: 1,
    status: 'ready',
    capturedAt: iso(capturedAt),
    degradedSince: null,
    failure: null
  };
}

export function degradedAcademicMonitorState(previousState, capturedAt, failure = 'academic_scan_failed') {
  const at = iso(capturedAt);
  const degradedSince = previousState?.status === 'degraded' && previousState?.degradedSince
    ? previousState.degradedSince
    : at;
  return {
    version: 1,
    status: 'degraded',
    capturedAt: at,
    degradedSince,
    failure: String(failure || 'academic_scan_failed').slice(0, 120)
  };
}

export function academicReportFailure(report) {
  if (!report?.summary) return 'academic_report_missing';
  const degraded = [];
  if (report.summary.mailStatus && report.summary.mailStatus !== 'ready') degraded.push('mail');
  if (report.summary.gradeStatus && report.summary.gradeStatus !== 'ready') degraded.push('grades');
  if (report.summary.notificationStatus && report.summary.notificationStatus !== 'ready') degraded.push('notifications');
  return degraded.length ? 'academic_sources_degraded:' + degraded.join(',') : null;
}

export function academicHealthAttention(state) {
  if (!state || state.version !== 1) throw new Error('university_health_state_invalid');
  if (state.status !== 'degraded') {
    return {
      version: 1,
      capturedAt: state.capturedAt,
      required: false,
      reasons: [],
      items: []
    };
  }
  return {
    version: 1,
    capturedAt: state.capturedAt,
    required: true,
    reasons: ['academic_monitor_degraded'],
    items: ['health:' + state.degradedSince]
  };
}
