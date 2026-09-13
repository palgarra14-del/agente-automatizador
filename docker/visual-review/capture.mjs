import { chromium } from 'playwright';

const raw = process.env.PREVIEW_URL;
if (!raw) throw new Error('PREVIEW_URL is required');
const target = new URL(raw);
if (target.protocol !== 'https:' || !target.hostname.endsWith('.vercel.app') || target.username || target.password || target.hash) {
  throw new Error('preview URL is not an allowed Vercel HTTPS target');
}
const blocked = new Set();
const browser = await chromium.launch({ headless: true });

const allowed = (value, websocket = false) => {
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.hostname === target.hostname && (websocket ? url.protocol === 'wss:' : url.origin === target.origin);
};

async function render(name, width, height, isMobile) {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile,
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
    colorScheme: 'light'
  });
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (allowed(url)) await route.continue();
    else {
      try { blocked.add(new URL(url).origin); } catch { blocked.add('invalid-url'); }
      await route.abort('blockedbyclient');
    }
  });
  await context.routeWebSocket(/.*/, async (ws) => {
    if (allowed(ws.url(), true)) await ws.connectToServer();
    else {
      try { blocked.add(new URL(ws.url()).origin); } catch { blocked.add('invalid-websocket'); }
      ws.close({ code: 1008, reason: 'cross-origin websocket blocked' });
    }
  });
  const page = await context.newPage();
  const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  if (!response || response.status() >= 400) throw new Error(`preview navigation failed: ${response?.status() ?? 'no-response'}`);
  const final = new URL(page.url());
  if (final.origin !== target.origin) throw new Error('preview redirected outside allowed origin');
  await page.waitForTimeout(1_200);
  const metrics = await page.evaluate(() => ({
    width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)
  }));
  if (metrics.width > 6_000 || metrics.height > 20_000) throw new Error('rendered page exceeds visual capture bounds');
  const title = await page.title();
  const path = `/output/${name}.png`;
  await page.screenshot({ path, fullPage: true, animations: 'disabled', caret: 'hide', timeout: 20_000 });
  await context.close();
  return { name, width, height, isMobile, path, title, finalUrl: final.href, document: metrics };
}

try {
  const desktop = await render('desktop', 1440, 900, false);
  const mobile = await render('mobile', 390, 844, true);
  process.stdout.write(JSON.stringify({
    version: 1,
    origin: target.origin,
    finalUrl: desktop.finalUrl,
    title: desktop.title,
    blockedOrigins: [...blocked].sort().slice(0, 50),
    captures: [desktop, mobile]
  }));
} finally {
  await browser.close();
}
