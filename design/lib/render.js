'use strict';
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const MAX_HEIGHT = 4000;
const LOAD_TIMEOUT_MS = 10000;
const sessions = new WeakMap(); // chrome -> sessionId (one reusable target per Chrome)

async function getSession(chrome) {
  const known = sessions.get(chrome);
  if (known) return known;
  const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true });
  await chrome.send('Page.enable', {}, sessionId);
  sessions.set(chrome, sessionId);
  const drop = (p, sid) => { if (sid === sessionId || p.sessionId === sessionId) sessions.delete(chrome); };
  chrome.on('Target.detachedFromTarget', drop);
  chrome.on('Inspector.targetCrashed', (p, sid) => { if (sid === sessionId) sessions.delete(chrome); });
  return sessionId;
}

function darkScript(dark) {
  if (!dark) return null;
  if (dark.class) return `document.documentElement.classList.add(${JSON.stringify(dark.class)})`;
  if (dark.attr) return `document.documentElement.setAttribute(${JSON.stringify(dark.attr)}, ${JSON.stringify(dark.value)})`;
  return null;
}

// cssContentSize is floored at the viewport height (800), so a short page would
// always measure 800 (and body.scrollHeight does too in quirks mode). Measure the lowest element edge instead; fall back to the metrics.
const MEASURE = `(() => {
  const b = document.body;
  if (!b) return 0;
  const cs = getComputedStyle(b);
  const sy = window.scrollY;
  let bottom = 0;
  for (const el of b.querySelectorAll('*')) {
    if (getComputedStyle(el).position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.height > 0 || r.width > 0) bottom = Math.max(bottom, r.bottom + sy);
  }
  if (!bottom) bottom = b.getBoundingClientRect().bottom + sy;
  return Math.ceil(bottom + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.marginBottom) || 0));
})()`;

async function contentHeight(chrome, sid) {
  const r = await chrome.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true }, sid);
  const v = r.result && r.result.value;
  if (Number.isFinite(v) && v > 0) return v;
  const metrics = await chrome.send('Page.getLayoutMetrics', {}, sid);
  return Math.ceil(metrics.cssContentSize.height);
}

async function renderOnce(chrome, { htmlPath, width, height, dark, out }) {
  const t0 = Date.now();
  const sid = await getSession(chrome);
  await chrome.send('Emulation.setDeviceMetricsOverride',
    { width, height: height ?? 800, deviceScaleFactor: 2, mobile: false }, sid);

  let cancelLoad = () => {};
  const loaded = new Promise((resolve, reject) => {
    const onLoad = (p, s) => { if (s === sid) { cleanup(); resolve(); } };
    const onExit = () => { cleanup(); reject(new Error('chrome exited')); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('load timeout'));
      chrome.abort('load timeout'); // a page that never loads wedges the shared target
    }, LOAD_TIMEOUT_MS);
    function cleanup() {
      clearTimeout(timer);
      chrome.off('Page.loadEventFired', onLoad);
      chrome.off('exit', onExit);
    }
    chrome.on('Page.loadEventFired', onLoad);
    chrome.on('exit', onExit);
    cancelLoad = cleanup;
  });
  loaded.catch(() => {}); // never unobserved: it may reject while we still await navigate
  try {
    const nav = await chrome.send('Page.navigate', { url: pathToFileURL(htmlPath).href }, sid);
    if (nav.errorText) throw new Error('navigate failed: ' + nav.errorText);
  } catch (e) {
    cancelLoad(); // drop timer + listeners so a dead navigate cannot abort Chrome later
    throw e;
  }
  await loaded;

  const script = darkScript(dark);
  if (script) await chrome.send('Runtime.evaluate', { expression: script }, sid);

  const content = await contentHeight(chrome, sid);
  const h = height ?? Math.min(content, MAX_HEIGHT);
  const cut = !height && content > MAX_HEIGHT;

  const shot = await chrome.send('Page.captureScreenshot', {
    format: 'png', clip: { x: 0, y: 0, width, height: h, scale: 1 }, captureBeyondViewport: true,
  }, sid);
  const tmp = out + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(shot.data, 'base64'));
  fs.renameSync(tmp, out);
  return { width, height: h, cut, ms: Date.now() - t0 };
}

async function renderPage(chrome, opts) {
  try {
    return await renderOnce(chrome, opts);
  } catch (e) {
    if (chrome.exited) throw e;
    sessions.delete(chrome); // stale target: retry once on a fresh one
    return renderOnce(chrome, opts);
  }
}

module.exports = { renderPage };
