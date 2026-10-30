// UI 2: drive the REAL dashboard UI (clicks, typing) against the real extension + a local target site.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stageExtension, startServer, startEdge, killEdge, EXT_ID, sleep, Cdp } from './harness.mjs';
import { startPagesServer } from './pages-server.mjs';

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? '  -> ' + String(detail).slice(0, 600) : '')); };
const watchdog = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 330000);

const hits = [];
const target = await startServer((req, res) => {
  const u = new URL(req.url, 'http://x'); hits.push(u.pathname);
  res.setHeader('content-type', 'text/html');
  if (u.pathname === '/login') return res.end('<title>Sign in</title><form><input type="password"></form>');
  res.end(`<title>${u.pathname}</title><body style="margin:0;background:hsl(${(u.pathname.length * 61) % 360},60%,75%);font:48px sans-serif">${u.pathname}</body>`);
});
const T = `http://127.0.0.1:${target.port}`;
const pages = await startPagesServer({});
const D = `http://localhost:${pages.port}${pages.prefix}`;
let ctx, ui;
const downloads = path.join(os.tmpdir(), 'essa-dl-' + Date.now());
fs.mkdirSync(downloads, { recursive: true });

const ev = (expr) => ui.eval(expr);
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const click = (sel) => ev(`${q(sel)}.click()`);
const text = (sel) => ev(`${q(sel)}?.textContent ?? null`);
// "Visible" = present, not hidden, rendered with a real size. (Not offsetParent: a modal <dialog> sits in the top layer
// and has offsetParent === null even while fully visible.)
const visible = (sel) => ev(`(() => { const e = ${q(sel)}; if (!e || e.hidden) return false; const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; })()`);
const disabled = (sel) => ev(`${q(sel)}.disabled`);
const waitUntil = async (fn, ms = 30000, label = '') => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(250); } throw new Error('timeout: ' + label); };
const go = async (file) => { await ui.send('Page.navigate', { url: D + file }); await sleep(1500); await waitUntil(() => ev(`/Extension connected/.test(document.querySelector('#conn-text')?.textContent||'')`), 15000, 'connected on ' + file); };
const setVal = (sel, v) => ev(`(() => { const e = ${q(sel)}; e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);

try {
  ctx = await startEdge({ extDir: stageExtension({ pattern: `http://localhost${pages.prefix}*` }) });
  const tab = await (await fetch(`http://127.0.0.1:${ctx.port}/json/new?about:blank`, { method: 'PUT' })).json();
  ui = await Cdp.connect(tab.webSocketDebuggerUrl);
  await ui.send('Page.enable');
  await ui.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true }).catch(() => ui.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }));

  /* ============ Settings page ============ */
  await go('settings.html');
  check('SET1 defaults shown: login URL, 100% zoom, 5 s delay', (await ev(`document.querySelector('#loginUrl').value`)) === 'https://aaj23525.apps.dynatrace.com/' && (await text('#zoom-readout')) === '100%' && (await ev(`document.querySelector('#pageDelaySeconds').value`)) === '5');
  check('SET2 delay preset 5 is pressed; presets are 3/5/10/15', JSON.stringify(await ev(`[...document.querySelectorAll('#delay-presets button')].map(b => b.textContent + ':' + b.getAttribute('aria-pressed'))`)) === JSON.stringify(['3 s:false', '5 s:true', '10 s:false', '15 s:false']));
  check('SET3 zoom slider bounds are 50..200 step 5', (await ev(`(() => { const r = document.querySelector('#zoomPercent'); return [r.min, r.max, r.step].join(); })()`)) === '50,200,5');
  check('SET4 only Microsoft Edge is offered (no browser picker)', !(await ev(`!!document.querySelector('select[name*=browser i], input[name*=browser i]')`)));

  // invalid values: the extension's validator must reject and the page must show it next to the field
  await setVal('#loginUrl', 'javascript:alert(1)');
  await click('#save'); await sleep(900);
  check('SET5 invalid login URL is rejected with a message next to the field', /Only https|cannot be automated|valid/i.test(await text('#loginUrl-err')) , await text('#loginUrl-err'));
  check('SET6 the field is marked invalid for assistive tech', (await ev(`${q('#loginUrl')}.getAttribute('aria-invalid')`)) === 'true');
  await setVal('#loginUrl', `${T}/login`);
  await click('#save'); await sleep(900);
  check('SET7 plain-HTTP login URL rejected while "Allow HTTP" is off', /HTTP/i.test(await text('#loginUrl-err')), await text('#loginUrl-err'));
  await ev(`${q('#allowHttp')}.click()`);
  await setVal('#zoomPercent', '150'); await setVal('#pageDelaySeconds', '3'); await setVal('#navigationTimeoutSeconds', '15');
  await click('#mode-full');
  await click('#save');
  await waitUntil(() => ev(`/Saved/.test(document.querySelector('#save-state').textContent)`), 8000, 'saved');
  check('SET8 valid settings save', true);
  await ev(`location.reload()`); await sleep(1500); await waitUntil(() => ev(`/Extension connected/.test(document.querySelector('#conn-text')?.textContent||'')`), 15000, 'reconnect');
  await sleep(600);
  check('SET9 settings persist across a page reload (stored in the extension)', (await ev(`document.querySelector('#zoomPercent').value`)) === '150' && (await ev(`document.querySelector('#loginUrl').value`)).startsWith(T) && (await ev(`document.querySelector('#mode-full').checked`)));
  check('SET10 zoom readout follows the slider', (await text('#zoom-readout')) === '150%');

  /* ============ Dashboard: URL manager ============ */
  await go('index.html');
  await sleep(500);
  const addUrl = async (u) => { await setVal('#url-new', u); await click('#url-add'); await sleep(150); };
  await addUrl(`${T}/one`); await addUrl(`${T}/two`); await addUrl(`${T}/three`);
  check('URL1 three URLs listed in a numbered list', (await ev(`document.querySelectorAll('#url-list li').length`)) === 3 && (await text('#url-list li:first-child .num')) === '1.');
  await addUrl('not a url');
  check('URL2 invalid URL refused with a message', /valid|absolute/i.test(await text('#url-error')), await text('#url-error'));
  await addUrl(`${T}/one`);
  check('URL3 duplicate URL not added twice', (await ev(`document.querySelectorAll('#url-list li').length`)) === 3);
  await ev(`document.querySelector('#url-list li:nth-child(3) [data-a="up"]').click()`);
  const order = await ev(`[...document.querySelectorAll('#url-list li input')].map(i => i.value.replace(${JSON.stringify(T)}, ''))`);
  check('URL4 reorder (move up) works', JSON.stringify(order) === JSON.stringify(['/one', '/three', '/two']), JSON.stringify(order));
  await ev(`(() => { const i = document.querySelector('#url-list li:nth-child(2) input'); i.value = ${JSON.stringify(T + '/edited')}; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  check('URL5 edit a URL in place', (await ev(`document.querySelectorAll('#url-list li input')[1].value`)).endsWith('/edited'));
  await ev(`document.querySelector('#url-list li:nth-child(2) [data-a="del"]').click()`);
  check('URL6 remove a URL', (await ev(`document.querySelectorAll('#url-list li').length`)) === 2);
  await addUrl(`${T}/three`);
  check('URL7 unsaved-changes indicator shown', /Unsaved/.test(await text('#url-dirty')));
  await click('#url-save'); await waitUntil(() => ev(`/Saved/.test(document.querySelector('#url-dirty').textContent)`), 8000, 'url saved');
  check('URL8 list saved', true);
  // import / export through the real file chooser path
  const exported = await ev(`(() => { return [...document.querySelectorAll('#url-list li input')].map(i => i.value); })()`);
  check('URL9 final order is what will be visited', JSON.stringify(exported.map((u) => u.replace(T, ''))) === JSON.stringify(['/one', '/two', '/three']), JSON.stringify(exported));

  /* ============ Dashboard: login gate through the real buttons ============ */
  check('GATE1 idle: Start is disabled, Open Login enabled, Pause/Resume/Stop disabled', (await disabled('#b-start')) && !(await disabled('#b-open')) && (await disabled('#b-pause')) && (await disabled('#b-resume')) && (await disabled('#b-stop')));
  check('GATE2 no login panel yet', !(await visible('.login-panel')));
  hits.length = 0;
  await click('#b-open');
  await waitUntil(() => visible('.login-panel'), 15000, 'login panel');
  check('GATE3 login panel appears with the exact required wording', /Waiting for user login/.test(await text('.login-panel .status-line')) && /Complete your login and MFA in Microsoft Edge/.test(await text('.login-panel')) && (await text('#lp-confirm')) === "I'm Logged In — Continue Automation" && (await text('#lp-cancel')) === 'Cancel', await text('.login-panel'));
  check('GATE4 login page was opened in Edge', hits.includes('/login'), JSON.stringify(hits));
  await sleep(3500);
  check('GATE5 while waiting: nothing from the URL list was visited', !['/one', '/two', '/three'].some((p) => hits.includes(p)), JSON.stringify(hits));
  check('GATE6 Start still disabled while waiting; Stop available', (await disabled('#b-start')) && !(await disabled('#b-stop')));
  // Cancel keeps automation stopped
  await click('#lp-cancel'); await waitUntil(async () => !(await visible('.login-panel')), 8000, 'panel gone');
  check('GATE7 Cancel hides the panel and nothing ran', !['/one', '/two', '/three'].some((p) => hits.includes(p)) && /Idle/.test(await text('#s-state')), await text('#s-state'));
  // Open again and confirm
  await click('#b-open'); await waitUntil(() => visible('.login-panel'), 15000, 'login panel 2');
  await click('#lp-confirm');

  /* ============ run, live progress ============ */
  // wait for the run to be demonstrably underway (not a transient label that can flash by between polls)
  await waitUntil(() => ev(`document.querySelector('#f-url').textContent.startsWith('http') || document.querySelector('#s-captured').textContent !== '0'`), 20000, 'run underway');
  check('RUN1 login panel disappears after confirming', !(await visible('.login-panel')));
  check('RUN2 Start disabled and Pause/Stop enabled while running', (await disabled('#b-start')) && !(await disabled('#b-pause')) && !(await disabled('#b-stop')) && (await disabled('#b-open')));
  check('RUN3 current URL and page counter are shown', /127\.0\.0\.1/.test(await text('#f-url')) && /\d of 3/.test(await text('#f-page')), `${await text('#f-url')} | ${await text('#f-page')}`);
  await waitUntil(() => ev(`/Completed/.test(document.querySelector('#s-state').textContent)`), 120000, 'completion');
  check('RUN4 completed: 100% bar, 3 captured, 0 failed', (await ev(`${q('#bar')}.getAttribute('aria-valuenow')`)) === '100' && (await text('#s-captured')) === '3' && /No failures/.test(await text('#s-failed')), `${await text('#s-captured')} ${await text('#s-failed')}`);
  check('RUN5 visited in order', JSON.stringify(hits.filter((p) => ['/one', '/two', '/three'].includes(p))) === JSON.stringify(['/one', '/two', '/three']), JSON.stringify(hits));
  // After a COMPLETED run in the same Edge window the confirmed login is still valid, so Start Automation is offered to
  // repeat it (a dead session is caught on the first page and demands a fresh login). Start is never offered after Stop.
  check('RUN6 after completion Start Automation is available to repeat the run', !(await disabled('#b-start')) && await disabled('#b-pause') && !(await disabled('#b-open')));

  /* ============ Gallery ============ */
  await go('gallery.html');
  await waitUntil(() => ev(`document.querySelectorAll('#grid .shot').length === 3`), 15000, '3 shots');
  check('GAL1 three shots with thumbnail, filename, url, time, status, Download + Delete', await ev(`[...document.querySelectorAll('#grid .shot')].every(s => s.querySelector('img')?.src.startsWith('data:image/jpeg') && s.querySelector('.fn').textContent.endsWith('.png') && s.querySelector('.src').textContent.startsWith('http') && /Captured/.test(s.querySelector('.pill').textContent) && s.querySelector('[data-a=dl]') && s.querySelector('[data-a=del]'))`));
  check('GAL2 total count shown', /3 of 3 screenshots/.test(await text('#count')), await text('#count'));
  check('GAL3 sidebar badge shows 3', (await text('#nav-count')) === '3');
  await setVal('#filter', 'two');
  check('GAL4 filter narrows the list', (await ev(`document.querySelectorAll('#grid .shot').length`)) === 1 && /1 of 3/.test(await text('#count')));
  await setVal('#filter', '');
  await setVal('#sort', 'old');
  const oldFirst = await ev(`[...document.querySelectorAll('#grid .shot .src')].map(e => e.textContent.replace(${JSON.stringify(T)}, ''))`);
  await setVal('#sort', 'new');
  const newFirst = await ev(`[...document.querySelectorAll('#grid .shot .src')].map(e => e.textContent.replace(${JSON.stringify(T)}, ''))`);
  check('GAL5 sort by capture time (oldest first = run order, newest first = reverse)', JSON.stringify(oldFirst) === JSON.stringify(['/one', '/two', '/three']) && JSON.stringify(newFirst) === JSON.stringify(['/three', '/two', '/one']), JSON.stringify({ oldFirst, newFirst }));

  // preview
  await ev(`document.querySelector('#grid .shot .thumb').click()`);
  await waitUntil(() => ev(`document.querySelector('#v-img').src.startsWith('data:image/png')`), 10000, 'preview image');
  const dim = await ev(`({ w: document.querySelector('#v-img').naturalWidth, h: document.querySelector('#v-img').naturalHeight, open: document.querySelector('#viewer').open })`);
  check('GAL6 larger preview opens with the real full-size PNG', dim.open && dim.w > 300 && dim.h > 200, JSON.stringify(dim));
  await ev(`document.querySelector('#viewer').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`); await sleep(600);
  check('GAL7 arrow keys move between screenshots', /\/two|\/one/.test(await text('#v-foot')), await text('#v-foot'));
  await click('#v-close');

  // single download
  const before = new Set(fs.readdirSync(downloads));
  await ev(`document.querySelector('#grid .shot [data-a=dl]').click()`);
  const single = await waitUntil(() => { const n = fs.readdirSync(downloads).filter((f) => !before.has(f) && !f.endsWith('.crdownload')); return n[0]; }, 15000, 'single download');
  const sb = fs.readFileSync(path.join(downloads, single));
  check('DL1 single download is a real PNG file with a descriptive name', sb.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && /^\d{3}_127\.0\.0\.1_.*\d{8}-\d{6}\.png$/.test(single), single);

  // ZIP of selected
  await click('#sel-all');
  check('DL2 select-all selects every shown item', /3 selected/.test(await text('#count')));
  const before2 = new Set(fs.readdirSync(downloads));
  await click('#dl-sel');
  const zipName = await waitUntil(() => fs.readdirSync(downloads).find((f) => f.endsWith('.zip') && !before2.has(f)), 20000, 'zip download');
  await sleep(500);
  const zp = path.join(downloads, zipName);
  const ex = path.join(downloads, 'unz'); fs.mkdirSync(ex, { recursive: true });
  const tarRes = spawnSync('tar', ['-xf', zp, '-C', ex], { encoding: 'utf8' });
  const files = fs.readdirSync(ex);
  check('DL3 bulk download is one ZIP that a real unzip tool extracts cleanly', tarRes.status === 0 && files.length === 3, `${tarRes.stderr} ${files}`);
  check('DL4 every extracted file is a valid PNG', files.every((f) => fs.readFileSync(path.join(ex, f)).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))));
  check('DL5 ZIP entries have unique, sanitised names', new Set(files.map((f) => f.toLowerCase())).size === 3 && files.every((f) => /^[\w.\-%]+\.png$/.test(f)), files.join(', '));
  check('DL6 progress reports completion', /3 of 3 saved/.test(await text('#dl-text')), await text('#dl-text'));

  // individual PNGs when ZIP is unticked
  await ev(`${q('#as-zip')}.click()`);
  // Start from a folder with no PNGs (this is the test's own temp folder): the single download in DL1 already saved
  // one of these same file names, so counting "new" files is ambiguous. With none present, three PNGs can only
  // exist if all three downloads really happened.
  for (const f of fs.readdirSync(downloads)) if (f.endsWith('.png')) fs.rmSync(path.join(downloads, f));
  await click('#dl-all');
  let separate = [];
  try {
    await waitUntil(() => (separate = fs.readdirSync(downloads).filter((f) => f.endsWith('.png'))).length >= 3, 25000, 'three separate pngs');
  } catch (e) {
    console.log('--- PNGs present at DL7 timeout: ' + separate.join(', '));
    throw e;
  }
  const valid = separate.every((f) => fs.readFileSync(path.join(downloads, f)).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  check('DL7 with ZIP unticked, "Download all" saves three separate, valid PNGs', separate.length === 3 && valid, separate.join(', '));
  await ev(`${q('#as-zip')}.click()`);

  // delete one, then clear all, with confirmation dialogs
  await click('#sel-none');
  await ev(`document.querySelector('#grid .shot [data-a=del]').click()`);
  await waitUntil(() => visible('dialog.confirm'), 5000, 'confirm dialog');
  await ev(`document.querySelector('dialog.confirm [data-act=no]').click()`); await sleep(300);
  check('DEL1 cancelling the confirmation keeps the screenshot', (await ev(`document.querySelectorAll('#grid .shot').length`)) === 3);
  await ev(`document.querySelector('#grid .shot [data-a=del]').click()`);
  await waitUntil(() => visible('dialog.confirm'), 5000, 'confirm dialog 2');
  await ev(`document.querySelector('dialog.confirm [data-act=yes]').click()`);
  await waitUntil(() => ev(`document.querySelectorAll('#grid .shot').length === 2`), 10000, 'one deleted');
  check('DEL2 confirming deletes exactly one screenshot', true);
  await click('#del-all');
  await waitUntil(() => visible('dialog.confirm'), 5000, 'confirm clear');
  check('DEL3 "Clear gallery" asks first and says it does not log you out', /not log you out/i.test(await text('dialog.confirm')));
  await ev(`document.querySelector('dialog.confirm [data-act=yes]').click()`);
  await waitUntil(() => ev(`document.querySelectorAll('#grid .shot').length === 0 && !document.querySelector('#empty').hidden`), 10000, 'gallery empty');
  check('DEL4 gallery cleared, empty state shown, badge 0', (await text('#nav-count')) === '0');
} catch (e) {
  try { const st = await ui.eval(`new Promise((res) => chrome.runtime.sendMessage('${EXT_ID}', { v: 1, cmd: 'state.get' }, res))`); console.log('--- extension state at failure ---'); console.log(JSON.stringify({ state: st.run.state, action: st.run.action, err: st.run.lastError, warnings: st.run.warnings, results: st.run.results, next: st.run.nextIndex, urls: st.run.urls, loginConfirmed: st.run.loginConfirmed }, null, 1)); console.log('UI:', await ui.eval(`document.querySelector('#s-state').textContent + ' | url=' + document.querySelector('#f-url').textContent`)); } catch (e2) { console.log('(could not read state)', e2.message); }
  check('harness ran to completion', false, e.stack || e.message);
} finally {
  if (ctx) killEdge(ctx.edge);
  target.server.close(); pages.server.close();
  try { fs.rmSync(downloads, { recursive: true, force: true }); } catch {}
  clearTimeout(watchdog);
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
