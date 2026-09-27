import { createWindowsUniversityBrowserBridge } from '../src/university-browser-windows.js';

const allowedOrigins = String(process.env.UNIVERSITY_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

if (!allowedOrigins.length) throw new Error('UNIVERSITY_ALLOWED_ORIGINS is required');

const bridge = createWindowsUniversityBrowserBridge({ allowedOrigins });
const status = await bridge.status();
const pages = await bridge.listReadablePages();
const first = pages[0] ? await bridge.readPage(pages[0].id) : null;

console.log(JSON.stringify({
  status,
  pages,
  first: first ? {
    ...first,
    text: first.text.slice(0, 300)
  } : null
}, null, 2));
