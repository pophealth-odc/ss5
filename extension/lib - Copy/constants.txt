// Shared by the extension and the dashboard (the dashboard imports this file from ../extension/lib/).
// Keep it free of chrome.* calls so it loads in either place.

export const PROTOCOL_VERSION = 1;

// Extension ID is fixed by the "key" in manifest.json, so the dashboard can default to it.
export const DEFAULT_EXTENSION_ID = 'ihedfabnpfjninccblgdbojfilhbhlnj';

export const PLACEHOLDER_MARKER = 'YOUR-GITHUB-USERNAME';

export const STATES = Object.freeze({
  IDLE: 'idle',
  OPENING_LOGIN: 'opening_login',
  WAITING_LOGIN: 'waiting_login',
  WAITING_CONFIRMATION: 'waiting_confirmation',
  PREPARING: 'preparing',
  NAVIGATING: 'navigating',
  WAITING_LOAD: 'waiting_load',
  CAPTURING: 'capturing',
  SAVING: 'saving',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  STOPPED: 'stopped',
  ERROR: 'error',
});

export const STATE_LABELS = Object.freeze({
  idle: 'Idle',
  opening_login: 'Opening login page',
  waiting_login: 'Waiting for manual login',
  waiting_confirmation: 'Waiting for user confirmation',
  preparing: 'Preparing browser',
  navigating: 'Navigating',
  waiting_load: 'Waiting for page load',
  capturing: 'Capturing screenshot',
  saving: 'Saving screenshot',
  paused: 'Paused',
  completed: 'Completed',
  stopped: 'Stopped',
  error: 'Error',
});

// States in which the runner is actively working (a run loop is executing).
export const BUSY_STATES = Object.freeze([
  'preparing', 'navigating', 'waiting_load', 'capturing', 'saving',
]);

export const DEFAULT_SETTINGS = Object.freeze({
  loginUrl: 'https://aaj23525.apps.dynatrace.com/',
  allowHttp: false,
  zoomPercent: 100,
  reapplyZoomEachPage: true,
  pageDelaySeconds: 5,
  navigationTimeoutSeconds: 45,
  autoCapture: true,
  captureMode: 'visible', // 'visible' | 'full'
  includeLoginPage: false,
  filenameFormat: '{index}_{page}_{timestamp}',
  continueOnError: true,
  detectSessionExpiry: true,
});

export const LIMITS = Object.freeze({
  zoomMin: 50,
  zoomMax: 200,
  zoomStep: 5,
  delayPresets: [3, 5, 10, 15],
  delayMin: 1,
  delayMax: 120,
  navTimeoutMin: 10,
  navTimeoutMax: 180,
  maxUrls: 500,
  maxUrlLength: 2048,
  filenameFormatMax: 120,
  filenameMax: 120,
});

export const FILENAME_TOKENS = Object.freeze(['index', 'page', 'host', 'date', 'time', 'timestamp']);

// Every command the dashboard may send. Anything else is rejected.
export const COMMANDS = Object.freeze([
  'ping',
  'state.get',
  'settings.save',
  'urls.save',
  'run.openLogin',
  'run.cancelLogin',
  'run.confirmLogin',
  'run.start',
  'run.pause',
  'run.resume',
  'run.stop',
  'gallery.list',
  'gallery.get',
  'gallery.delete',
  'gallery.clear',
  'data.clearAll',
]);

export const EXAMPLE_URLS = Object.freeze([
  'https://example.com/',
  'https://example.org/',
  'https://www.iana.org/domains/reserved',
]);
