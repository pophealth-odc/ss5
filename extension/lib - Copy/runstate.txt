// Pure run-state logic (no chrome.* calls): the state machine's transition table, progress maths,
// and the checks used to decide whether a page is a real success, a failure, or a sign-in page.
// Kept separate from runner.js so it can be unit-tested in plain Node.

import { STATES, BUSY_STATES } from './constants.js';

const S = STATES;

/** Which commands are allowed in which states. The runner consults this before doing anything. */
const ALLOWED = {
  openLogin:  [S.IDLE, S.COMPLETED, S.STOPPED, S.ERROR],
  cancelLogin: [S.OPENING_LOGIN, S.WAITING_LOGIN, S.WAITING_CONFIRMATION],
  confirmLogin: [S.WAITING_LOGIN, S.WAITING_CONFIRMATION, S.PAUSED], // PAUSED only counts when a re-login is required (see isAllowed)
  start:      [S.IDLE, S.COMPLETED, S.STOPPED, S.ERROR], // only valid if a login was confirmed this session (see availableActions)
  pause:      BUSY_STATES,
  resume:     [S.PAUSED],
  stop:       [...BUSY_STATES, S.PAUSED, S.OPENING_LOGIN, S.WAITING_LOGIN, S.WAITING_CONFIRMATION],
};

/**
 * Is `action` allowed? Pass the run (or just a state string). Two actions depend on more than the state:
 *   confirmLogin while PAUSED  - only when the pause was a forced re-login (loginConfirmed === false)
 *   resume       while PAUSED  - only when the login is still confirmed (a re-login pause must be confirmed, not resumed)
 */
export function isAllowed(action, runOrState) {
  const state = typeof runOrState === 'string' ? runOrState : runOrState?.state;
  if (!ALLOWED[action] || !ALLOWED[action].includes(state)) return false;
  if (typeof runOrState === 'object' && runOrState && state === S.PAUSED) {
    if (action === 'confirmLogin') return runOrState.loginConfirmed === false;
    if (action === 'resume') return runOrState.loginConfirmed !== false;
  }
  return true;
}

export function isBusy(state) {
  return BUSY_STATES.includes(state);
}

/** What the dashboard should offer the user in this state (drives button enabling). */
export function availableActions(run) {
  const r = run && typeof run === 'object' ? run : { state: S.IDLE, loginConfirmed: false };
  const loggedIn = !!r.loginConfirmed;
  return {
    openLogin: isAllowed('openLogin', r),
    cancelLogin: isAllowed('cancelLogin', r),
    confirmLogin: isAllowed('confirmLogin', r),
    start: isAllowed('start', r) && loggedIn,
    pause: isAllowed('pause', r),
    resume: isAllowed('resume', r),
    stop: isAllowed('stop', r),
  };
}

export function emptyRun() {
  return {
    runId: null,
    state: S.IDLE,
    action: '',
    loginConfirmed: false,
    windowId: null,
    tabId: null,
    urls: [],            // the snapshot of URLs this run will visit
    nextIndex: 0,        // next URL to process (resume continues here)
    zoomLedger: {},      // origin -> zoom factor the site had before this run changed it (restored when the run ends)
    captured: 0,
    failed: 0,
    currentUrl: null,
    lastError: null,
    warnings: [],
    startedAt: null,
    updatedAt: null,
    results: [],         // [{ index, url, status:'ok'|'failed'|'skipped', error?, screenshotId? }]
  };
}

export function progress(run) {
  const total = run?.urls?.length ?? 0;
  const done = Math.min(run?.results?.length ?? 0, total);
  return {
    total,
    done,
    page: total === 0 ? 0 : Math.min(done + (isBusy(run.state) ? 1 : 0), total),
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}

/** On service-worker restart: a run that was mid-flight cannot still be running, so it becomes a safe pause. */
export function recoverAfterRestart(run) {
  if (!run || typeof run !== 'object') return emptyRun();
  const base = { ...emptyRun(), ...run };
  if (isBusy(base.state)) {
    return {
      ...base,
      state: S.PAUSED,
      action: 'The extension restarted while capturing. Press Resume to continue from the next page.',
      warnings: [...(base.warnings || []), 'Extension restarted during a run; paused safely.'].slice(-10),
    };
  }
  if (base.state === S.OPENING_LOGIN) {
    return { ...base, state: S.WAITING_LOGIN, action: 'Complete your login and MFA in Microsoft Edge, then confirm.' };
  }
  return base;
}

/** Hosts differ only by case/"www." and trailing dots - treated as the same site. */
export function sameSite(a, b) {
  try {
    const norm = (h) => h.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    return norm(new URL(a).hostname) === norm(new URL(b).hostname);
  } catch { return false; }
}

/**
 * Judge what a page probe says. `probe` is what the in-page script returned; `requested` is the URL we asked for.
 * Returns { kind: 'ok' | 'error-page' | 'http-error' | 'stale' | 'auth', message }.
 */
export function judgeProbe(probe, { requested, loginUrl, detectSessionExpiry = true, startedAt = 0 }) {
  if (!probe || probe.err) {
    const m = String(probe?.err || '');
    if (/showing error page/i.test(m)) {
      return { kind: 'error-page', message: 'The page could not be reached (connection refused, DNS failure, or no internet).' };
    }
    if (/cannot access|cannot be scripted|chrome:\/\/|edge:\/\//i.test(m)) {
      return { kind: 'error-page', message: 'This is a protected browser page and cannot be captured.' };
    }
    return { kind: 'error-page', message: m || 'The page could not be inspected.' };
  }
  if (typeof probe.timeOrigin === 'number' && startedAt && probe.timeOrigin < startedAt - 250) {
    return { kind: 'stale', message: 'The page did not finish loading in time; the previous page was still showing.' };
  }
  if (typeof probe.status === 'number' && probe.status >= 400) {
    return { kind: 'http-error', message: `The server answered HTTP ${probe.status}.` };
  }
  if (detectSessionExpiry && looksLikeSignIn(probe, { requested, loginUrl })) {
    return { kind: 'auth', message: 'The site is asking you to sign in again (your session may have expired).' };
  }
  return { kind: 'ok', message: '' };
}

const AUTH_PATH = /(^|[/._-])(login|signin|sign-in|sso|saml|oauth2?|authorize|auth|adfs|logon)([/._?-]|$)/i;
const AUTH_HOST = /(^|\.)(login\.microsoftonline\.com|login\.live\.com|accounts\.google\.com|okta\.com|oktapreview\.com|auth0\.com|onelogin\.com|pingidentity\.com|pingone\.com|duosecurity\.com|sso\.dynatrace\.com)$/i;

/**
 * Heuristic: did this navigation land on a sign-in page we did NOT ask for?
 * Deliberately conservative: it only fires if the final URL differs from the request AND looks like a login page
 * (or the page has a password field and a login-ish URL). It never fires for a URL the user listed on purpose.
 */
export function looksLikeSignIn(probe, { requested, loginUrl } = {}) {
  let landed;
  try { landed = new URL(probe.href); } catch { return false; }
  let want = null;
  try { want = new URL(requested); } catch { /* ignore */ }

  const redirectedAway = !want || landed.origin !== want.origin || landed.pathname !== want.pathname;
  if (!redirectedAway) return false;

  // The user explicitly listed this sign-in page (or the login URL) - not an expiry.
  if (loginUrl) {
    try { const l = new URL(loginUrl); if (landed.origin === l.origin && landed.pathname === l.pathname && want && want.pathname === l.pathname) return false; } catch { /* ignore */ }
  }
  const urlLooksAuth = AUTH_HOST.test(landed.hostname) || AUTH_PATH.test(landed.pathname);
  if (urlLooksAuth) return true;
  return !!probe.pwd && (probe.redirects ?? 0) > 0 && /login|sign|auth|sso/i.test(landed.href);
}

/**
 * Zoom bookkeeping. Edge remembers an applied zoom PER SITE (measured: it survives closing the window, and
 * switching the tab back to "automatic" does not undo it), so every site we zoom must be put back afterwards.
 * `ledger` maps origin -> the zoom factor that site had before we first touched it.
 */
export function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

/** Record `origin`'s pre-run zoom the first time we see it. Returns a NEW ledger (inputs are not mutated). */
export function noteOriginalZoom(ledger, origin, zoomFactor) {
  if (!origin || typeof zoomFactor !== 'number' || !Number.isFinite(zoomFactor)) return ledger || {};
  if (ledger && Object.prototype.hasOwnProperty.call(ledger, origin)) return ledger;
  return { ...(ledger || {}), [origin]: zoomFactor };
}

/** The sites whose zoom still needs restoring. */
export function originsToRestore(ledger) {
  return Object.entries(ledger || {}).map(([origin, zoom]) => ({ origin, zoom }));
}
