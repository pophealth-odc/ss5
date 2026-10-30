# Edge Screenshot Automation

Opens your login page in **Microsoft Edge**, waits while **you** sign in (including MFA), then visits a list of URLs and saves a screenshot of each one. Everything runs on your own computer.

- **Dashboard** - static HTML/CSS/JavaScript hosted on **GitHub Pages**. It shows settings, progress and the screenshot gallery.
- **Extension** - a Microsoft Edge Manifest V3 extension. It does the actual browser work (open pages, zoom, capture) using Edge's extension APIs.

GitHub Pages can't control a browser, so the dashboard only sends commands to the extension that you installed. No Node.js, Playwright, Puppeteer, Python, backend server, database, paid service or cloud automation is involved. The dashboard talks to the extension directly; nothing is uploaded anywhere.

> **You never hand over a password.** Login and MFA are completely manual. The tool does not read, type, store or transmit passwords, MFA codes, cookies or session tokens.

---

## Contents

1. [How it works](#how-it-works)
2. [Quick start](#quick-start)
3. [Step-by-step setup](#step-by-step-setup)
4. [Using it](#using-it)
5. [Settings reference](#settings-reference)
6. [Permissions - what the extension can do and why](#permissions)
7. [Privacy and security](#privacy-and-security)
8. [Limits and honest caveats](#limits-and-honest-caveats)
9. [What has been tested, and what has not](#what-has-been-tested-and-what-has-not)
10. [Troubleshooting](#troubleshooting)
11. [Inspecting and removing the extension](#inspecting-and-removing-the-extension)
12. [Repository layout](#repository-layout)
13. [Running the tests](#running-the-tests)

Also: [Running it on localhost](#running-it-on-localhost-no-github-needed) (no GitHub needed).

---

## How it works

```
 GitHub Pages dashboard  ──(chrome.runtime messages, origin-checked)──►  Edge extension
 (settings, progress, gallery)                                           (opens pages, zoom, screenshots)
                                                                                │
                                                                                ▼
                                                              Edge window you can see and sign in to
```

1. You press **Open Login Page**. The extension opens your login URL in a maximised Edge window.
2. The dashboard shows **"Waiting for user login"**. You sign in and complete MFA in that Edge window.
3. You press **I'm Logged In - Continue Automation**. Only now does anything else happen.
4. The extension visits your URLs in order. For each page it waits for loading, applies the zoom, waits the extra delay, captures, and saves the image locally.
5. Screenshots appear in the gallery. You download them one by one, as a selection, or all at once.

The extension refuses to navigate or capture anything before step 3. If your session expires mid-run, it pauses and asks you to sign in and confirm again.

---

## Quick start

1. Put the project in a GitHub repository and turn on GitHub Pages ([details](#step-by-step-setup)).
2. In `extension/manifest.json`, replace `YOUR-GITHUB-USERNAME` with your GitHub user name (and the repository name if it isn't `edge-screenshot-automation`).
3. In Edge: `edge://extensions` → **Developer mode** → **Load unpacked** → choose the `extension` folder.
4. Open your dashboard address (`https://YOUR-NAME.github.io/edge-screenshot-automation/`). The indicator should read **Extension connected**.

---

## Step-by-step setup

### 1. Create the GitHub repository

1. Sign in at github.com and choose **New repository**.
2. Name it `edge-screenshot-automation` (or anything you like - just keep it consistent below).
3. Choose **Public**. (GitHub Pages on a free account requires a public repository. The repository contains no private data - see [Privacy](#privacy-and-security).)
4. Leave "Add a README" unticked, because this project already has one. Create the repository.

### 2. Upload the source code

Use whichever you prefer:

- **Web upload:** on the new repository page choose **uploading an existing file**, drag in the *contents* of this folder (`index.html`, `settings.html`, `gallery.html`, `css`, `js`, `extension`, `tests`, `README.md`, `.gitignore`), and commit.
- **Git:**
  ```
  git init
  git add .
  git commit -m "Edge Screenshot Automation"
  git branch -M main
  git remote add origin https://github.com/YOUR-GITHUB-USERNAME/edge-screenshot-automation.git
  git push -u origin main
  ```

Make sure `index.html` is at the **top level** of the repository, not inside a sub-folder.

### 3. Enable GitHub Pages

1. Repository → **Settings** → **Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**, branch **main**, folder **/ (root)**, and **Save**.
3. Wait a minute or two. The page shows your address, normally:
   `https://YOUR-GITHUB-USERNAME.github.io/edge-screenshot-automation/`

The site is plain static files; no build step runs. All asset paths are relative, so it works under the repository sub-path.

### 4. Tell the extension your dashboard address (the one manual edit)

The extension only accepts commands from **your** dashboard. That address is set in **one place**, `extension/manifest.json`:

```json
"externally_connectable": {
  "matches": ["https://YOUR-GITHUB-USERNAME.github.io/edge-screenshot-automation/*"]
}
```

Replace `YOUR-GITHUB-USERNAME` with your GitHub user name. If you named the repository differently, change `edge-screenshot-automation` to match. Keep the trailing `/*`.

Until you do this, the extension deliberately **refuses every request** (including from the correct page) and tells you so. This is a safety feature, not a bug.

> Using a custom domain? Put that exact address in the same field, for example `https://tools.example.org/shots/*`. Wildcard host names (`*.github.io`) are rejected, because they would trust everyone on that domain.

### 5. Load the extension in Microsoft Edge

1. Download or clone the repository to your PC so you have the `extension` folder (with your edited `manifest.json`).
2. In Edge, open `edge://extensions`.
3. Turn on **Developer mode** (bottom-left or top-right, depending on your version).
4. Choose **Load unpacked** and select the **`extension`** folder (the one containing `manifest.json`).
5. The extension **Edge Screenshot Automation** appears. Its ID is `ihedfabnpfjninccblgdbojfilhbhlnj`; it is fixed by a key in the manifest so it is the same on every computer.

If you edit `manifest.json` later, press **Reload** on the extension card.

Edge may show a "disable developer-mode extensions" banner at start-up. That's normal for unpacked extensions - choose to keep it.

### 6. Check the connection

Open your dashboard address. The top-right indicator should say **Extension connected · Idle**. If it says *not connected*, jump to [Troubleshooting](#troubleshooting).

### 7. Set the login URL and screenshot options

Open **Settings**:

- **Default login URL** - starts as `https://aaj23525.apps.dynatrace.com/`. Change it to yours.
- **Browser page scale** - 100% by default (50-200% in 5% steps).
- **Page loading delay** - 5 s by default (presets 3 / 5 / 10 / 15 s, or any value 1-120).
- **Capture mode** - visible area (default) or full page.
- File name format, "continue after error", and other options (see the [reference](#settings-reference)).

Press **Save settings**.

### 8. Add the pages to visit

On the **Dashboard**, use **Pages to visit**: add URLs, edit them, reorder with ↑/↓, remove, or **Import from .txt** (one URL per line; `#` starts a comment). **Export to .txt** saves the list. Press **Save list**.

The login page is **not** in this list and is not captured unless you tick *Also capture the login page* in Settings.

### 9. Log in, confirm, run

1. Press **Open Login Page**. Edge opens, maximised, on your login URL.
2. Sign in and complete MFA **in that Edge window**.
3. Return to the dashboard and press **I'm Logged In - Continue Automation**.
4. Watch the progress. You may **Pause**, **Resume** or **Stop** at any time.

> Keep that Edge window open and **don't switch tabs inside it** while a run is in progress. Edge can only capture the tab that is on screen. You can use other windows for other work, but don't minimise or cover the automation window - a minimised window can't be captured.

### 10. View and download screenshots

Open **Gallery**. Click a thumbnail for a larger preview (arrow keys move between shots). Download one, tick several and **Download selected**, or **Download all**. Multiple files are bundled into one ZIP by default; untick the box to get separate PNGs instead.

---

## Running it on localhost (no GitHub needed)

Handy for trying it out before you publish anything. This uses Node.js **only to serve the files**; the deployed version is still plain static files.

```
node tools/serve-local.mjs
```

It prints the address, `http://localhost:5287/edge-screenshot-automation/`, and does three things:

1. Serves this repository exactly as GitHub Pages would (same sub-path, same file types, `tests/` and dot-folders hidden). It listens on **127.0.0.1 only**, so other computers on your network can't reach it.
2. Writes a copy of the extension to `.local/extension` whose `manifest.json` trusts **only** `http://localhost:5287/edge-screenshot-automation/*`. Your real `extension/manifest.json` is not modified.
3. Tells you what to do in Edge:
   - Open `edge://extensions` and turn on **Developer mode**.
   - If you already loaded the `extension` folder, **remove it first** (two copies of the same extension can't both be installed - they share one ID).
   - **Load unpacked** → choose `.local\extension`.
   - Open `http://localhost:5287/edge-screenshot-automation/`. The top-right indicator should say **Extension connected**.

Use another port with `node tools/serve-local.mjs --port 8080` (the extension copy is regenerated for that port - reload it in `edge://extensions`). Stop the server with **Ctrl+C**.

**Why the port is pinned.** The address in the manifest includes the port, so a page on any *other* local port cannot control the extension (verified in Edge: it gets no access at all). A pattern without a port, such as `http://localhost/*`, would let *any* program on your PC that serves a web page take screenshots of your signed-in sessions, so don't use one. The same applies if you ever run a different local server: the extension will ignore it.

When you are ready for GitHub Pages, remove the localhost copy from Edge and load the real `extension` folder with your `github.io` address in its manifest ([step 4](#4-tell-the-extension-your-dashboard-address-the-one-manual-edit)).

---

## Using it

| Control | What it does |
| --- | --- |
| **Open Login Page** | Opens the login URL in a maximised Edge window and starts waiting for you. |
| **I'm Logged In - Continue Automation** | Your explicit confirmation. Starts exactly one run. Stays available for as long as you need. |
| **Cancel** | Abandons the login. Nothing is visited. |
| **Start Automation** | Repeats the run. Only enabled after a run has **completed** in the same Edge window, while your confirmed login is still valid. It is never enabled before your first confirmation, after **Stop**, after an error, or once the Edge window is closed. (The first run is started by **I'm Logged In**.) |
| **Pause** | Finishes the current step, then stops before the next page. |
| **Resume** | Continues from the next unprocessed page without repeating finished ones. |
| **Stop** | Stops scheduling new pages and keeps what's already captured. |
| **Clear Gallery** | Asks first, then deletes all stored screenshots. It does **not** log you out of any website. |

Your login confirmation lasts as long as the run and, after a run **completes**, for repeating it with **Start Automation** while that same Edge window stays open. After a **Stop**, an error, a cancel, or closing the window, you log in and confirm again. If a repeated run finds your session has expired, it pauses at the first page and asks you to sign in and confirm again.

### If your session expires

If a page sends you back to a sign-in screen, the run **pauses**, nothing else is visited, and the dashboard shows *"Session needs a fresh login"*. Sign in again in the Edge window and press **I'm Logged In** - the run continues from the page that triggered the sign-in, without duplicating anything.

---

## Settings reference

| Setting | Default | Notes |
| --- | --- | --- |
| Default login URL | `https://aaj23525.apps.dynatrace.com/` | Validated before use. |
| Allow plain HTTP | off | HTTPS only unless you turn this on (intended for internal test sites). |
| Capture the login page too | off | |
| Pause on sign-in redirect | on | Detects an expired session after navigation. |
| Browser page scale | 100% | 50-200%, step 5%. Applied at the start and re-applied after each page. |
| Re-apply zoom after every page | on | Edge resets zoom per site. When off, zoom is still applied at the start of a run. |
| Page loading delay | 5 s | Extra wait after the page reports it has loaded (1-120 s). |
| Give up on a page after | 45 s | A page that never loads is marked failed instead of freezing the run (10-180 s). |
| Capture mode | Visible area | Or **Full page** (scroll and stitch) - see limits below. |
| Capture automatically | on | Off = only visit pages. |
| Continue after an error | on | Off = stop at the first failed page. |
| File name format | `{index}_{page}_{timestamp}` | Placeholders: `{index}` `{page}` `{host}` `{date}` `{time}` `{timestamp}`. Illegal characters are replaced; duplicates get `-2`, `-3`... |

The browser is always Microsoft Edge, and the window is always requested maximised. If Edge refuses, you see a warning rather than a silent failure.

---

## Permissions

Requested in `extension/manifest.json`:

| Permission | Why it is needed |
| --- | --- |
| `host_permissions: <all_urls>` | **Edge only allows `captureVisibleTab` when the extension has access to all sites** (or after a toolbar click, which doesn't work for a multi-page run). A narrower grant was tested and refused: `Either the '<all_urls>' or 'activeTab' permission is required`. The extension uses it to take screenshots and to read a page's address, title and load status. It does **not** read page text, form values, passwords or cookies. |
| `scripting` | To check that a page actually loaded (and isn't an error page), to scroll for full-page capture, and to confirm the zoom level. |
| `storage`, `unlimitedStorage` | To keep your settings, URL list and screenshots on this computer. `unlimitedStorage` stops Edge's quota from rejecting large screenshots. |
| `externally_connectable` | Only your dashboard's address can send commands. |

Not requested: `tabs`, `downloads`, `cookies`, `webRequest`, `history`, `activeTab`, `alarms` - none are needed. There is no `zoom` permission in Edge; `chrome.tabs.setZoom` needs none. Downloads are done by the dashboard page itself, so the `downloads` permission isn't required.

The extension injects code only into the tab it's automating, and only small read-only helper functions (page status, scrolling, zoom check). It never injects into other tabs.

---

## Privacy and security

- **Local only.** Settings, the URL list and screenshots live in this Edge profile (`chrome.storage.local` and IndexedDB). Nothing is sent to any server, analytics service or third party. The shipped code contains no `fetch`, `XMLHttpRequest`, `WebSocket` or `eval`.
- **Never stored:** passwords, MFA codes, cookies, tokens or form values. The only page-content check is "does a password field exist?", used to recognise a sign-in screen; its contents are never read.
- **Screenshots may show private information.** They are saved exactly as the pages look. Treat the ZIP files you download accordingly, and don't commit them to GitHub (`.gitignore` excludes `*.zip`).
- **Who can control the extension:** the browser delivers messages only from the exact address in `manifest.json`; the extension then re-checks the sender's address (and refuses embedded frames), validates the command name against a fixed list, validates every field, and caps message size. Destructive commands need an explicit `confirm: true`. Other web pages cannot reach it at all.
- **Dashboard hardening:** each page sets a strict Content-Security-Policy (`default-src 'none'; script-src 'self'`; no inline scripts or styles, no network access beyond its own origin). Text from websites (titles, URLs, errors) is always HTML-escaped or inserted as plain text.
- **No secrets in the repository.** The extension's *public* key is in `manifest.json` (that is what fixes its ID). The matching private key was generated, used once to derive the ID, and discarded; it isn't in the project and isn't needed. `.gitignore` blocks `*.pem`.
- **Clearing data:** *Settings → Delete all stored data*, the Clear Gallery button, or the button on the extension's details page. None of these sign you out of any website.

---

## Limits and honest caveats

- **Chromium extension APIs only.** This works in **Microsoft Edge on Windows**. Other browsers aren't supported.
- **The Edge window must stay visible.** Edge can only screenshot the visible tab of a window that isn't minimised. Don't minimise or cover the automation window during a run.
- **Capture rate.** Edge allows about two `captureVisibleTab` calls per second; captures are throttled and retried, so full-page capture of a long page takes some seconds.
- **Full-page capture is real, but with limits.** It scrolls and stitches. Verified: normal tall pages, and app-style pages where one large inner panel scrolls (header kept on top). Not handled: content inside **cross-origin iframes**, several independent scroll panels, and content that loads lazily more slowly than the settle time. **Fixed/sticky headers** are shown once, at the top of the image, not repeated. Images are cut at **20,000 pixels** tall (and about 80 megapixels); when that happens the gallery entry says so. A page that doesn't need scrolling is saved as the visible area and labelled that way. If you need exact output for a particular site, test it first.
- **Zoom.** Edge remembers an applied zoom *per site*, so the extension records each site's zoom before changing it and puts it back afterwards (verified, including a pre-existing 125%). If Edge is closed mid-run before restoring, that site may stay at the run's zoom; reset with **Ctrl+0**. Zoom is verified against the real page (the browser's own reported zoom value alone isn't trusted, as it was seen to disagree).
- **Failed pages are detected honestly.** Connection errors, DNS failures, HTTP 4xx/5xx, pages that never load, and protected browser pages are marked failed with a reason, and **no screenshot is saved for them** (Edge would otherwise screenshot its own error page, or the previous page).
- **Session-expiry detection is a heuristic.** It recognises a redirect to a sign-in page (by address pattern, known identity providers, or a password field plus a login-like address). A site that expires sessions in an unusual way may not be detected and the page would be captured as-is.
- **The service worker can be stopped by Edge at any time.** If that happens mid-run, the run comes back as **Paused** with a warning; press **Resume**. At most one page may be re-visited.
- **Storage.** Screenshots are PNGs in Edge's storage. If space runs out the run stops with a clear message. Delete screenshots to free space.
- **Developer-mode extension.** Because it is loaded unpacked, Edge shows a start-up notice. Publishing to the Edge Add-ons store is outside this project.
- **ZIP files** use the plain ZIP format (no compression, since PNGs are already compressed): up to 4 GB and 65,535 files. For bigger sets, untick the ZIP option for separate PNGs.
- **Display scaling.** Windows display scaling (125%, 150% …) is supported and was tested by emulation.

---

## What has been tested, and what has not

**Verified automatically in real Microsoft Edge (155) with an isolated throw-away profile** - 16 test suites, all passing (`node tests/run-all.mjs`):

| Area | Evidence |
| --- | --- |
| Extension loads; trust boundary | Placeholder address refuses everyone; only the exact configured address and path can connect; other paths, look-alike paths and other hosts get no `chrome.runtime` at all; unknown commands, bad versions and bad payloads rejected. |
| Login gate | Nothing is visited while waiting; Start is refused before confirmation; two simultaneous confirmations start exactly one run; the confirmation is cleared by Stop, error, cancel or a closed window; a completed run can be repeated with Start in the same window, without duplicates. |
| Run | URLs visited in order; 404/hung/error pages recorded as failed without stopping the run; PNGs are real, decodable and non-blank. |
| Pause / resume / stop | No further navigation after pause or stop; resume continues without duplicates. |
| Session expiry | Run pauses on a sign-in redirect, **Resume is refused**, re-confirmation continues with no duplicate screenshots. |
| Window closed / worker killed | Closing the window pauses safely; killing the service worker mid-run recovers as Paused and Resume completes with every page captured once. |
| Zoom | Applied and verified on the real page; restored per site (including a user's own 125%) across multiple origins. |
| Full page | Pixel-verified: correct height, all 14 test sections in order, no seams/gaps, header once, scroll position restored; 50-200% zoom × display scale 1, 1.25, 1.5 and 2. Two real stitching bugs were found and fixed this way. |
| Dashboard | All three pages load from a project **sub-path** with no errors, no CSP violations and no off-origin requests; the real buttons, settings validation, URL manager, gallery, preview, filter/sort, delete confirmations. |
| Downloads | Single PNG; bulk ZIP extracted with the Windows `tar` tool and read by Python's `zipfile` (CRCs and bytes identical); separate PNGs. |
| Accessibility | Names/labels, landmarks, keyboard reachability, WCAG AA contrast in light and dark (including login/alert states), no sideways scroll at 480 px. |
| Security | HTML-injection scan (every template interpolation reviewed) plus a live hostile-title/URL test that proves nothing executes. |

**Not tested - needs your own verification:**

- **Your real login.** No test used the Dynatrace tenant, a real SSO provider or real MFA (the tool never touches credentials, and I can't sign in as you). Confirm that a sign-in redirect on *your* site pauses the run as expected before relying on it.
- **Real GitHub Pages hosting.** Tested against a local server that mimics a project sub-path (correct MIME types, nothing served outside the path). The first deploy is the first test on github.io itself.
- **Your Edge channel and managed-device policy.** Tested on Edge 155 stable. A company policy that blocks developer-mode extensions or sideloading will stop installation; that's a policy matter, not something this project can bypass.
- **Real-world page behaviour.** Heavy single-page apps, canvas dashboards, lazy-loading and animations vary. Raise the loading delay if charts are blank.
- **A physical high-DPI or multi-monitor setup.** Scaling was emulated, not run on real hardware.
- **Very large galleries** (hundreds of full-page images) and low disk space.

---

## Troubleshooting

**"Extension not connected" on the dashboard**

1. Open `edge://extensions` and confirm *Edge Screenshot Automation* is present and **on**.
2. Open the extension's **Details → Extension options**. *Trusted dashboard* must say **Configured** and show your address. "Not set up yet" means `manifest.json` still contains `YOUR-GITHUB-USERNAME`.
3. The address in `manifest.json` must match the dashboard's address exactly: same `https://`, same user, same repository name, ending in `/*`. After editing it, press **Reload** on the extension, then reload the dashboard.
4. Make sure you're using **Microsoft Edge** (not Firefox/Safari), and the dashboard is opened from `https://`.
5. Settings → *Extension connection* shows the ID the dashboard uses. It must equal the ID on `edge://extensions` (`ihedfabnpfjninccblgdbojfilhbhlnj`).

**"The extension did not answer in time"** - the service worker may have stopped. Reload the extension at `edge://extensions` and try again.

**Edge refuses to capture / "Site access"** - in `edge://extensions` → Details, make sure site access is **On all sites**. Edge internal pages (`edge://…`) and the Add-ons store can never be captured.

**A page is marked failed** - read the reason in the progress panel. Typical causes: the site was unreachable, answered HTTP 4xx/5xx, or never finished loading (raise *Give up on a page after*).

**Screenshots are blank or half-loaded** - increase *Page loading delay* (10-15 s), or the page needs more time to draw charts.

**The run paused by itself** - either your session expired (sign in and confirm again), the Edge window was closed, or Edge restarted the extension (press Resume).

**Storage is full / "Not enough local storage space"** - delete screenshots in the gallery (download them first). Low disk space on the PC has the same effect.

**Zoom looks wrong afterwards on a site** - press **Ctrl+0** on it. This only happens if Edge was closed during a run before the zoom could be restored.

**Downloads of many files** - Edge may ask whether to allow multiple downloads. Allow it, or keep the ZIP option ticked.

---

## Inspecting and removing the extension

- **See its code:** it's just the files in the `extension` folder you loaded. Nothing is minified or generated.
- **See what it stores:** `edge://extensions` → the extension → *Inspect views: service worker* → **Application** tab → *Local storage* and *IndexedDB*.
- **See what it can do:** `edge://extensions` → **Details** → *Permissions*.
- **Remove it:** `edge://extensions` → **Remove**. This deletes its stored data too. (Use the *Delete all stored data* button first if you want to be explicit.)

---

## Repository layout

```
index.html  settings.html  gallery.html     the three dashboard pages
css/styles.css                              the only stylesheet
js/
  app.js            shared shell: navigation, connection status, toasts, confirm dialog
  extension-bridge.js   the dashboard's only connection to the extension
  index.js  settings.js  gallery.js        page logic
  zip.js            small ZIP writer (no library)
extension/
  manifest.json     permissions + the ONE place the dashboard address is set
  background.js     service worker: message handling
  popup.html/js     toolbar popup (read-only status)
  options.html/js   extension details page
  icons/
  lib/
    constants.js    shared names, defaults, limits
    validate.js     URL / settings / file-name validation
    messaging.js    sender and command validation (the trust boundary)
    runner.js       the run: login gate, loop, pause/stop, recovery
    runstate.js     pure state-machine and judging logic
    browser.js      Edge primitives: window, navigate, zoom, page probe
    capture.js      throttled screenshots
    fullpage.js     scroll-and-stitch capture
    storage.js      chrome.storage + IndexedDB
tests/              unit tests, end-to-end tests, run-all.mjs
tools/serve-local.mjs   optional: run the dashboard on localhost (development only)
.local/             generated by serve-local (git-ignored)
```

---

## Running the tests

The shipped app needs no Node.js. The tests use it purely as a development convenience.

```
node tests/run-all.mjs --unit     # fast, no browser
node tests/run-all.mjs            # everything, including real Edge (needs Edge installed)
```

The browser tests launch Edge with a temporary profile (never your own), load a copy of the extension pointed at a local test server, and clean up afterwards. Set `EDGE_PATH` if Edge is installed somewhere unusual. To emulate a scaled Windows display:

```
$env:EDGE_SCALE = '1.25'; node tests/run-all.mjs
```
