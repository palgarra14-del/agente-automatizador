import { launchChromeCdpBrowser } from '../../src/browser-qa-runner.js';

const url = process.argv[2];
if (!url) throw new Error('usage: node local-qa.mjs <url>');
const origin = new URL(url).origin;
const controller = new AbortController();

function requestFor(width, height) {
  return {
    acceptance: {
      mobileViewport: { width, height },
      pages: [{ route: '/', requiredSections: [] }],
      targets: []
    }
  };
}

async function inspect(width, height) {
  const browser = await launchChromeCdpBrowser({
    signal: controller.signal,
    timeoutMs: 15000,
    allowedOrigin: origin,
    chromePath: '/usr/bin/google-chrome'
  });
  try {
    return await browser.inspectPage({
      request: requestFor(width, height),
      pagePlan: { route: '/', url },
      routeUrls: { '/': url },
      signal: controller.signal,
      timeoutMs: 15000,
      settleMs: 120
    });
  } finally {
    await browser.close();
  }
}

function defectsFor(probe, label) {
  const defects = [];
  if (!probe || probe.status < 200 || probe.status >= 400) defects.push(`${label}:http_status_${probe?.status ?? 'missing'}`);
  if ((probe?.bodyTextLength ?? 0) < 80) defects.push(`${label}:body_too_short`);
  if (probe?.errorOverlay) defects.push(`${label}:runtime_error_overlay`);
  if (probe?.horizontalOverflow) defects.push(`${label}:horizontal_overflow`);
  if (!probe?.metadata?.title) defects.push(`${label}:missing_title`);
  if (!probe?.metadata?.description) defects.push(`${label}:missing_description`);
  const unnamed = (probe?.interactiveControls ?? []).filter((item) => !String(item?.accessibleName ?? '').trim());
  for (const control of unnamed.slice(0, 12)) defects.push(`${label}:missing_accessible_name:${control.id ?? control.role ?? 'control'}`);
  return defects;
}

const [mobile, tablet, desktop] = await Promise.all([inspect(390, 844), inspect(768, 1024), inspect(1440, 900)]);
const defects = [...defectsFor(mobile, 'mobile'), ...defectsFor(tablet, 'tablet'), ...defectsFor(desktop, 'desktop')];
const result = {
  pass: defects.length === 0,
  defects,
  mobile: {
    status: mobile.status,
    bodyTextLength: mobile.bodyTextLength,
    horizontalOverflow: mobile.horizontalOverflow,
    errorOverlay: mobile.errorOverlay,
    metadata: mobile.metadata,
    designMetrics: mobile.designMetrics,
    interactiveControls: mobile.interactiveControls
  },
  tablet: {
    status: tablet.status,
    bodyTextLength: tablet.bodyTextLength,
    horizontalOverflow: tablet.horizontalOverflow,
    errorOverlay: tablet.errorOverlay,
    metadata: tablet.metadata,
    designMetrics: tablet.designMetrics,
    interactiveControls: tablet.interactiveControls
  },
  desktop: {
    status: desktop.status,
    bodyTextLength: desktop.bodyTextLength,
    horizontalOverflow: desktop.horizontalOverflow,
    errorOverlay: desktop.errorOverlay,
    metadata: desktop.metadata,
    designMetrics: desktop.designMetrics,
    interactiveControls: desktop.interactiveControls
  }
};
process.stdout.write(JSON.stringify(result, null, 2));
