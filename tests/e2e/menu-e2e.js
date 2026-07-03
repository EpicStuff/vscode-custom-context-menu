'use strict';

// Real end-to-end test: installs the extension (from a packaged .vsix, via each
// editor's own CLI), enables it through the command palette, reloads, and proves
// the configured items disappear from the editor right-click context menu.
//
// Two independent targets, each a node:test subtest (pass/fail on their own):
//   - code-server  serves its bundled WEB workbench; we drive it with headed
//                  Chromium (Playwright) and assert on the live menu DOM
//                  (item hiding, cursor anchoring, no stranded scrollbar).
//   - vscode       the REAL desktop VS Code Electron app; we drive it with
//                  Playwright's Electron driver (headed, under xvfb), open the
//                  editor menu, screenshot it, and OCR the image (tesseract,
//                  ImageMagick to upscale). Verification is screenshot+OCR only
//                  (no DOM): BEFORE shows "Copy"/"Cut", AFTER does not but still
//                  shows "Paste"/"Command Palette".
//
// This drives real software and installs NONE of it. Every prerequisite is
// resolved from the environment; if one is missing the test ERRORS with
// actionable instructions rather than skipping (you opted in by running
// `npm run test:e2e`).
//
//   Prerequisites (resolved from env first, then PATH/common locations):
//     CODE_SERVER_BIN   path to a code-server binary          (code-server target)
//     VSCODE_BIN        path to a desktop `code` CLI binary    (vscode target)
//     CHROMIUM_BIN      Chromium/Chrome binary           (code-server target)
//     PLAYWRIGHT_PATH   a playwright/playwright-core module to require (both)
//     TESSERACT_BIN     tesseract OCR binary                   (vscode target)
//     MAGICK_BIN        ImageMagick `magick`/`convert`         (vscode target)
//     CCM_VSIX          a prebuilt .vsix (else one is built with vsce)
//     DISPLAY           an X display (run under `xvfb-run -a npm run test:e2e`)
//     SCREENSHOT_DIR    where to drop per-phase screenshots
//                       (default <tmpdir>/ccm-e2e-screenshots)
//   At least one target (code-server or vscode) must be available.
//
// Named *-e2e.js (not *.test.js) so the default `node --test` / `npm test`
// does not pick it up — run it explicitly with `npm run test:e2e`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const SELECTORS = ['"Copy"', '"Cut"', '_'];
const PATCH_MARKER = '<!-- !! VSCODE-CUSTOM-CSS-START !! -->';
const repo = path.resolve(__dirname, '..', '..');

// ---- Prerequisite resolvers (error + instruct, never skip) ----------------

function resolveChromium() {
	const env = process.env.CHROMIUM_BIN;
	if (env) {
		if (fs.existsSync(env)) return env;
		throw new Error(`CHROMIUM_BIN points at ${env}, which does not exist.`);
	}
	for (const c of [
		'/usr/sbin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser',
		'/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
	]) if (fs.existsSync(c)) return c;
	const found = spawnSync('sh',
		['-c', 'command -v chromium || command -v chromium-browser || command -v google-chrome'],
		{ encoding: 'utf8' }).stdout.trim();
	if (found) return found;
	throw new Error(
		'No Chromium/Chrome binary was found. This e2e test drives a real browser and does not install one.\n' +
		'Install chromium (e.g. `pacman -S chromium`) or set CHROMIUM_BIN to an existing\n' +
		'Chromium/Chrome binary, then re-run `npm run test:e2e`.'
	);
}

function resolvePlaywright() {
	const tried = [];
	for (const mod of ['playwright', 'playwright-core']) {
		try { return require(mod); } catch { tried.push(mod); }
	}
	const fromEnv = process.env.PLAYWRIGHT_PATH;
	if (fromEnv) {
		try { return require(fromEnv); }
		catch (e) { throw new Error(`PLAYWRIGHT_PATH points at ${fromEnv}, which could not be required: ${e.message}`); }
	}
	throw new Error(
		'Playwright is not available. It is NOT a dependency of this project — resolve it externally.\n' +
		'Install it (`npm i -g playwright`) or set PLAYWRIGHT_PATH to a playwright/playwright-core\n' +
		`module directory, then re-run \`npm run test:e2e\`. (tried require of: ${tried.join(', ')})`
	);
}

// Resolve an executable from an env var, then PATH, then a list of candidates.
// Throws with an actionable message (never returns null) — used for hard
// prerequisites of a selected target.
function resolveTool(envVar, name, candidates, instruct) {
	const env = process.env[envVar];
	if (env) {
		if (fs.existsSync(env)) return env;
		throw new Error(`${envVar} points at ${env}, which does not exist.`);
	}
	for (const c of candidates || []) if (fs.existsSync(c)) return c;
	const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
	if (found) return found;
	throw new Error(instruct);
}

function resolveTesseract() {
	return resolveTool('TESSERACT_BIN', 'tesseract', ['/usr/sbin/tesseract', '/usr/bin/tesseract'],
		'tesseract (OCR) was not found. The vscode target verifies the menu via screenshot + OCR and does\n' +
		'not install it. Install it (`pacman -S tesseract tesseract-data-eng`) or set TESSERACT_BIN, then\n' +
		're-run `npm run test:e2e`.');
}

function resolveMagick() {
	// IM7 `magick`; fall back to IM6 `convert`. Used to upscale the menu crop so
	// small menu text OCRs reliably.
	const env = process.env.MAGICK_BIN;
	if (env) {
		if (fs.existsSync(env)) return env;
		throw new Error(`MAGICK_BIN points at ${env}, which does not exist.`);
	}
	for (const c of ['/usr/sbin/magick', '/usr/bin/magick', '/usr/sbin/convert', '/usr/bin/convert']) {
		if (fs.existsSync(c)) return c;
	}
	const found = spawnSync('sh', ['-c', 'command -v magick || command -v convert'], { encoding: 'utf8' }).stdout.trim();
	if (found) return found;
	throw new Error(
		'ImageMagick (`magick`/`convert`) was not found. The vscode target upscales the menu screenshot before\n' +
		'OCR and does not install it. Install it (`pacman -S imagemagick`) or set MAGICK_BIN, then re-run\n' +
		'`npm run test:e2e`.'
	);
}

function requireDisplay() {
	if (!process.env.DISPLAY) {
		throw new Error(
			'These headed editors need an X display, but DISPLAY is unset. Run the test under a virtual\n' +
			'framebuffer, e.g. `xvfb-run -a -s "-screen 0 1680x1200x24" npm run test:e2e`, or set DISPLAY.'
		);
	}
}

// Build (once) or locate the .vsix to install. `--install-extension` requires a
// real .vsix — it rejects a plain folder — so an unpacked copy will not do.
let _vsix;
function resolveVsix() {
	if (_vsix) return _vsix;
	const env = process.env.CCM_VSIX;
	if (env) {
		if (fs.existsSync(env)) { _vsix = env; return _vsix; }
		throw new Error(`CCM_VSIX points at ${env}, which does not exist.`);
	}
	const out = path.join(os.tmpdir(), `ccm-e2e-${process.pid}.vsix`);
	// `--no-dependencies` packages just the sources (the extension ships no
	// runtime deps); `--allow-missing-repository` keeps vsce non-fatal.
	const r = spawnSync('npx',
		['--yes', '@vscode/vsce', 'package', '--no-dependencies', '--allow-missing-repository', '-o', out],
		{ cwd: repo, encoding: 'utf8' });
	if (r.status === 0 && fs.existsSync(out)) { _vsix = out; return _vsix; }
	throw new Error(
		'Could not obtain a .vsix to install. Set CCM_VSIX to a prebuilt package, or make\n' +
		'`npx @vscode/vsce package` work in this repo (install @vscode/vsce), then re-run.\n' +
		`vsce exit=${r.status}\n${(r.stderr || '') + (r.stdout || '')}`
	);
}

function resolveBin(envVar, name) {
	const env = process.env[envVar];
	if (env) {
		if (fs.existsSync(env)) return env;
		throw new Error(`${envVar} points at ${env}, which does not exist.`);
	}
	const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
	return found || null;
}

// ---- Workbench restore -----------------------------------------------------

function findFiles(roots, name) {
	const out = [];
	for (const r of roots) {
		if (!r || !fs.existsSync(r)) continue;
		const res = spawnSync('find', [r, '-name', name, '-type', 'f'], { encoding: 'utf8' });
		for (const f of (res.stdout || '').split('\n').filter(Boolean)) out.push(f);
	}
	return out;
}

// Restore every workbench.html from its .orig backup, so a leftover patch from a
// prior run (or this run's finally) is undone and the shared install is pristine.
function restoreWorkbenches(roots, diag) {
	for (const orig of findFiles(roots, 'workbench.html.orig')) {
		const wb = orig.slice(0, -'.orig'.length);
		try {
			fs.copyFileSync(orig, wb);
			fs.unlinkSync(orig);
			if (diag) diag(`restored ${wb}`);
		} catch (e) { if (diag) diag(`could not restore ${wb}: ${e.message}`); }
	}
	// A patched workbench with no backup can't be auto-restored; surface it.
	for (const wb of findFiles(roots, 'workbench.html')) {
		try {
			if (fs.readFileSync(wb, 'utf8').includes(PATCH_MARKER) && diag) {
				diag(`WARNING: ${wb} is still patched and has no .orig backup`);
			}
		} catch { /* ignore */ }
	}
}

// ---- Server lifecycle (code-server target) ---------------------------------

function freePort() {
	return new Promise((res, rej) => {
		const srv = net.createServer();
		srv.once('error', rej);
		srv.listen(0, '127.0.0.1', () => {
			const p = srv.address().port;
			srv.close(() => res(p));
		});
	});
}

function hit(port, p) {
	return new Promise(r => {
		const req = http.get({ host: '127.0.0.1', port, path: p }, res => { res.resume(); r(true); });
		req.on('error', () => r(false));
		req.setTimeout(2000, () => { req.destroy(); r(false); });
	});
}

async function waitForHttp(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await hit(port, '/')) return;
		await new Promise(r => setTimeout(r, 1000));
	}
	throw new Error('server did not start listening in time.');
}

function killServer(proc, port, root) {
	try { process.kill(-proc.pid); } catch { /* gone */ }
	try { process.kill(proc.pid); } catch { /* gone */ }
	// Belt and suspenders: kill whatever still holds the port or references our
	// per-run dir. pkill is blocked here, so collect pids and signal them directly.
	const byPort = spawnSync('sh', ['-c', `ss -ltnp 2>/dev/null | grep ':${port} ' || true`], { encoding: 'utf8' }).stdout;
	for (const m of byPort.matchAll(/pid=(\d+)/g)) { try { process.kill(Number(m[1])); } catch { /* gone */ } }
	const byCmd = spawnSync('sh', ['-c',
		`for p in /proc/[0-9]*; do tr '\\0' ' ' < "$p/cmdline" 2>/dev/null | grep -q -- '${root}' && echo "\${p##*/}"; done || true`],
		{ encoding: 'utf8' }).stdout;
	for (const pid of byCmd.split('\n').filter(Boolean)) { try { process.kill(Number(pid)); } catch { /* gone */ } }
}

// ---- code-server target: WEB workbench DOM ---------------------------------

function codeServerTarget(bin) {
	// code-server's bin lives at <root>/bin/code-server and serves its workbench
	// from <root>/lib/vscode/out/vs/code/browser/workbench/workbench.html.
	const workbenchRoots = [path.dirname(path.dirname(fs.realpathSync(bin)))];
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-e2e-code-server-'));
	const dataDir = path.join(root, 'data');
	const extsDir = path.join(root, 'exts');
	const ws = path.join(root, 'ws');
	fs.mkdirSync(path.join(dataDir, 'User'), { recursive: true });
	fs.mkdirSync(extsDir, { recursive: true });
	fs.mkdirSync(ws, { recursive: true });
	return {
		root, ws, workbenchRoots,
		settingsPath: path.join(dataDir, 'User', 'settings.json'),
		installArgv: [bin, '--install-extension', resolveVsix(),
			'--extensions-dir', extsDir, '--user-data-dir', dataDir],
		serveArgv: (port) => [bin, '--bind-addr', `127.0.0.1:${port}`, '--auth', 'none',
			'--user-data-dir', dataDir, '--extensions-dir', extsDir, ws],
	};
}

// Pierce shadow roots to find the menu and report each item's label + visibility.
function inspectMenuInPage(click) {
	function* allRoots(root) {
		yield root;
		for (const el of root.querySelectorAll('*')) if (el.shadowRoot) yield* allRoots(el.shadowRoot);
	}
	let c = null;
	for (const r of allRoots(document)) {
		const f = r.querySelector && r.querySelector('.monaco-menu-container');
		if (f) { c = f; break; }
	}
	if (!c) return { found: false };
	const rect = c.getBoundingClientRect();
	const scrollable = c.querySelector('.monaco-scrollable-element');
	const actions = c.querySelector('.actions-container');
	const vbar = c.querySelector('.scrollbar.vertical');
	const items = Array.from(c.querySelectorAll('.action-item'));
	const rows = items.map(k => ({
		label: (k.querySelector('.action-label[aria-label]') || {}).ariaLabel ||
			(k.querySelector('.action-label.separator') ? '<sep>' : ''),
		hidden: getComputedStyle(k).display === 'none',
	}));
	return {
		found: true,
		anchorDx: Math.round(rect.left - click.x),
		anchorDy: Math.round(rect.top - click.y),
		contentH: actions ? actions.offsetHeight : null,
		scrollClientH: scrollable ? scrollable.clientHeight : null,
		vbarOpacity: vbar ? getComputedStyle(vbar).opacity : null,
		visibleLabels: rows.filter(r => !r.hidden).map(r => r.label),
		hiddenLabels: rows.filter(r => r.hidden).map(r => r.label),
	};
}

async function webLoadWorkbench(page, url) {
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
	await page.waitForSelector('.monaco-workbench', { timeout: 90000 });
	await page.waitForTimeout(11000);
}

// Open the editor context menu in a page, screenshot it, and inspect its DOM.
async function webOpenMenu(page, screenshotPath) {
	await page.locator('.monaco-list-row:has-text("app.js")').first().dblclick({ timeout: 15000 }).catch(() => {});
	await page.waitForSelector('.monaco-editor .view-lines', { timeout: 25000 });
	await page.waitForTimeout(1500);
	const box = await page.locator('.monaco-editor .view-lines').first().boundingBox();
	const click = { x: Math.round(box.x + 60), y: Math.round(box.y + 10) };
	await page.mouse.click(click.x, click.y, { button: 'right' });
	await page.waitForTimeout(2000);
	const info = await page.evaluate(inspectMenuInPage, click);
	try {
		await page.locator('.monaco-menu-container').first().screenshot({ path: screenshotPath, timeout: 5000 });
	} catch {
		await page.screenshot({ path: screenshotPath }).catch(() => {});
	}
	await page.keyboard.press('Escape');
	await page.waitForTimeout(500);
	return info;
}

async function runCodeServerFlow(t, bin, deps) {
	const cfg = codeServerTarget(bin);

	fs.writeFileSync(path.join(cfg.ws, 'app.js'),
		'function app() {\n\tconsole.log("line one");\n\treturn 42;\n}\napp();\n');
	fs.writeFileSync(cfg.settingsPath, JSON.stringify({
		'security.workspace.trust.enabled': false,
		'custom-contextmenu.selectors': SELECTORS,
	}, null, '\t'));

	const ins = spawnSync(cfg.installArgv[0], cfg.installArgv.slice(1), { encoding: 'utf8' });
	t.diagnostic(`[code-server] install exit=${ins.status}`);
	assert.equal(ins.status, 0, `[code-server] extension install failed: ${ins.stderr || ins.stdout}`);

	const shot = (phase) => path.join(deps.screenshotDir, `code-server-${phase}.png`);
	const port = await freePort();
	const serveArgv = cfg.serveArgv(port);
	const proc = spawn(serveArgv[0], serveArgv.slice(1), { stdio: 'ignore', detached: true });

	let browser;
	try {
		await waitForHttp(port, 90000);
		// Start from a pristine workbench so the before/after contrast is real.
		restoreWorkbenches(cfg.workbenchRoots, m => t.diagnostic(`[code-server] ${m}`));

		browser = await deps.chromium.launch({
			executablePath: deps.chromiumBin, headless: false,
			args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
		});
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		const url = `http://127.0.0.1:${port}/?folder=${cfg.ws}`;

		// --- Before enabling: Copy and Cut are present (sanity) ---
		await webLoadWorkbench(page, url);
		const before = await webOpenMenu(page, shot('before-enable'));
		t.diagnostic(`[code-server] before: ` + JSON.stringify(before));
		t.diagnostic(`[code-server] before screenshot: ` + shot('before-enable'));
		assert.ok(before.found, 'context menu should open before enabling');
		assert.ok(before.visibleLabels.includes('Copy'), 'Copy should be visible before enabling');
		assert.ok(before.visibleLabels.includes('Cut'), 'Cut should be visible before enabling');

		// --- Enable via the command palette ---
		await page.keyboard.press('Control+Shift+P');
		await page.waitForTimeout(1500);
		await page.keyboard.type('Enable Custom Context Menu', { delay: 25 });
		await page.waitForTimeout(1500);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(4000);
		const toasts = await page.locator('.notification-list-item-message').allInnerTexts().catch(() => []);
		t.diagnostic(`[code-server] toasts: ` + JSON.stringify(toasts));
		assert.ok(toasts.some(s => /Custom Context Menu enabled/i.test(s)),
			`Enable should report success; the workbench file must be writable (got: ${JSON.stringify(toasts)})`);

		// --- After enabling + reload: Copy/Cut/separators gone, others kept ---
		await webLoadWorkbench(page, url);
		const after = await webOpenMenu(page, shot('after-enable'));
		t.diagnostic(`[code-server] after: ` + JSON.stringify(after));
		t.diagnostic(`[code-server] after screenshot: ` + shot('after-enable'));
		assert.ok(after.found, 'context menu should open after enabling');

		// Item hiding: the configured labels are present-but-hidden, others stay.
		assert.ok(!after.visibleLabels.includes('Copy'), 'Copy should be hidden after enabling');
		assert.ok(!after.visibleLabels.includes('Cut'), 'Cut should be hidden after enabling');
		assert.ok(after.hiddenLabels.includes('Copy'), 'Copy should be present-but-hidden');
		assert.ok(after.hiddenLabels.includes('Cut'), 'Cut should be present-but-hidden');
		assert.ok(after.visibleLabels.includes('Paste'), 'unconfigured items (Paste) should stay visible');
		// Separator selector "_" trims separators.
		assert.ok(!after.visibleLabels.includes('<sep>'), 'separators should be hidden by the "_" selector');

		// Anchored at the cursor (not drifted by stale pre-hide layout).
		assert.ok(Math.abs(after.anchorDx) <= 24 && Math.abs(after.anchorDy) <= 24,
			`menu should anchor near the cursor, got dx=${after.anchorDx} dy=${after.anchorDy}`);

		// No stranded scrollbar: content fits, so the vertical scrollbar is hidden.
		if (after.contentH != null && after.scrollClientH != null && after.contentH <= after.scrollClientH) {
			assert.equal(after.vbarOpacity, '0', 'a menu whose content fits must not show a scrollbar');
		}
	} finally {
		if (browser) await browser.close().catch(() => {});
		killServer(proc, port, cfg.root);
		restoreWorkbenches(cfg.workbenchRoots, m => t.diagnostic(`[code-server] ${m}`));
		fs.rmSync(cfg.root, { recursive: true, force: true });
	}
}

// ---- vscode target: REAL desktop VS Code, screenshot + OCR -----------------

// Follow the `code` CLI wrapper(s) to the desktop install dir that holds the
// Electron binary and the on-disk workbench.html (the file the extension patches).
function resolveDesktopInstall(bin) {
	const electronNames = ['code', 'code-oss', 'codium', 'code-insiders', 'Code', 'VSCodium'];
	const candidates = [];
	const pushAncestors = (p) => {
		let d = p;
		for (let i = 0; i < 8 && d && d !== '/'; i++) { candidates.push(d); d = path.dirname(d); }
	};
	const real = fs.realpathSync(bin);
	pushAncestors(path.dirname(real));
	// Scan the wrapper script(s) for referenced absolute `code` paths and add
	// their ancestors — that's how /usr/sbin/code -> /usr/share/code is found.
	const toScan = [real];
	const scanned = new Set();
	while (toScan.length) {
		const s = toScan.pop();
		if (scanned.has(s)) continue;
		scanned.add(s);
		let txt;
		try {
			if (fs.statSync(s).size > 512 * 1024) continue; // never read the Electron binary
			txt = fs.readFileSync(s, 'utf8');
		} catch { continue; }
		if (txt.includes('\u0000')) continue; // binary, not a wrapper script
		for (const m of txt.matchAll(/\/[A-Za-z0-9_.+-]+(?:\/[A-Za-z0-9_.+-]+)*/g)) {
			const p = m[0];
			if (!/code/i.test(p) || !fs.existsSync(p)) continue;
			pushAncestors(p);
			if (/\/code$/.test(p) && !scanned.has(p)) toScan.push(p);
		}
	}
	candidates.push('/usr/share/code', '/usr/share/code-oss', '/usr/share/code-insiders',
		'/usr/share/codium', '/opt/visual-studio-code', '/opt/visual-studio-code-insiders');
	const seen = new Set();
	for (const root of candidates) {
		if (seen.has(root)) continue;
		seen.add(root);
		const out = path.join(root, 'resources', 'app', 'out');
		if (!fs.existsSync(out)) continue;
		const wb = findFiles([out], 'workbench.html')
			.find(w => /electron-(sandbox|browser)\/workbench\/workbench\.html$/.test(w));
		if (!wb) continue;
		const electron = electronNames
			.map(n => path.join(root, n))
			.find(e => { try { return fs.statSync(e).isFile(); } catch { return false; } });
		if (!electron) continue;
		return { installRoot: root, electronBin: electron, workbenchRoots: [out] };
	}
	throw new Error(
		`Could not locate the desktop VS Code install from ${bin}. Expected an install dir containing\n` +
		'`resources/app/out/.../electron-*/workbench/workbench.html` and an Electron binary. Set VSCODE_BIN\n' +
		'to the desktop `code` CLI of a normal VS Code install, then re-run `npm run test:e2e`.'
	);
}

// Upscale the menu crop (small text OCRs poorly) and run tesseract on it.
function ocrImage(img, deps) {
	const up = img.replace(/\.png$/, '-ocr.png');
	const m = spawnSync(deps.magick, [img, '-colorspace', 'Gray', '-resize', '300%', '-sharpen', '0x1', up],
		{ encoding: 'utf8' });
	const src = (m.status === 0 && fs.existsSync(up)) ? up : img;
	const r = spawnSync(deps.tesseract, [src, 'stdout', '--psm', '6'], { encoding: 'utf8' });
	return (r.stdout || '').replace(/\s+/g, ' ').trim();
}

const hasWord = (txt, w) => new RegExp(`\\b${w}\\b`, 'i').test(txt);

// Open the editor context menu in the Electron window and OCR a tight crop of it.
async function desktopOpenMenuOcr(page, fullPath, cropPath, deps) {
	await page.locator('.monaco-list-row:has-text("app.js")').first().dblclick({ timeout: 15000 }).catch(() => {});
	await page.waitForSelector('.monaco-editor .view-lines', { timeout: 25000 });
	await page.waitForTimeout(1500);
	const box = await page.locator('.monaco-editor .view-lines').first().boundingBox();
	const click = { x: Math.round(box.x + 60), y: Math.round(box.y + 10) };
	await page.mouse.click(click.x, click.y, { button: 'right' });
	await page.waitForTimeout(2000);
	await page.screenshot({ path: fullPath }).catch(() => {});
	let ocrSrc = fullPath;
	try {
		// A tight crop of just the menu massively improves OCR accuracy. This reads
		// the DOM only to size the screenshot — verification is still OCR of pixels.
		await page.locator('.monaco-menu-container').first().screenshot({ path: cropPath, timeout: 5000 });
		ocrSrc = cropPath;
	} catch { /* fall back to the full-window shot */ }
	await page.keyboard.press('Escape');
	await page.waitForTimeout(500);
	return ocrImage(ocrSrc, deps);
}

async function paletteRun(page, command) {
	await page.keyboard.press('Control+Shift+P');
	await page.waitForTimeout(1500);
	await page.keyboard.type(command, { delay: 25 });
	await page.waitForTimeout(1500);
	await page.keyboard.press('Enter');
}

async function runDesktopFlow(t, bin, deps) {
	const { installRoot, electronBin, workbenchRoots } = resolveDesktopInstall(bin);
	t.diagnostic(`[vscode] install=${installRoot} electron=${electronBin}`);
	const { _electron } = resolvePlaywright();
	const tesseract = resolveTesseract();
	const magick = resolveMagick();
	const ocr = { tesseract, magick };

	// Undo any stale patch left in the shared install before we start.
	restoreWorkbenches(workbenchRoots, m => t.diagnostic(`[vscode] ${m}`));

	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-e2e-vscode-'));
	const D = path.join(root, 'data'); // serves as both --user-data-dir and --extensions-dir
	const ws = path.join(root, 'ws');
	fs.mkdirSync(path.join(D, 'User'), { recursive: true });
	fs.mkdirSync(ws, { recursive: true });
	fs.writeFileSync(path.join(ws, 'app.js'),
		'function app() {\n\tconsole.log("line one");\n\treturn 42;\n}\napp();\n');
	fs.writeFileSync(path.join(D, 'User', 'settings.json'), JSON.stringify({
		'security.workspace.trust.enabled': false,
		'custom-contextmenu.selectors': SELECTORS,
	}, null, '\t'));

	const ins = spawnSync(bin, ['--no-sandbox', '--install-extension', resolveVsix(),
		'--extensions-dir', D, '--user-data-dir', D], { encoding: 'utf8' });
	t.diagnostic(`[vscode] install exit=${ins.status}`);
	assert.equal(ins.status, 0, `[vscode] extension install failed: ${ins.stderr || ins.stdout}`);

	const shot = (phase) => path.join(deps.screenshotDir, `vscode-${phase}.png`);

	let app;
	try {
		app = await _electron.launch({
			executablePath: electronBin,
			args: ['--no-sandbox', '--disable-gpu', '--disable-workspace-trust',
				'--user-data-dir', D, '--extensions-dir', D,
				'--skip-release-notes', '--skip-welcome', ws],
			timeout: 120000,
		});
		let page = await app.firstWindow({ timeout: 120000 });
		// Maximize so a tall context menu fits fully on screen and OCRs in one shot.
		await app.evaluate(({ BrowserWindow }) => {
			const w = BrowserWindow.getAllWindows()[0];
			if (w) w.maximize();
		}).catch(() => {});
		await page.waitForSelector('.monaco-workbench', { timeout: 90000 });
		await page.waitForTimeout(8000);

		// --- Before enabling: the menu shows Copy and Cut ---
		const before = await desktopOpenMenuOcr(page, shot('before-full'), shot('before-menu'), ocr);
		t.diagnostic(`[vscode] before OCR: ${JSON.stringify(before)}`);
		t.diagnostic(`[vscode] before screenshots: ${shot('before-menu')} | ${shot('before-full')}`);
		assert.ok(hasWord(before, 'Copy'), `BEFORE menu should OCR "Copy"; got: ${before}`);
		assert.ok(hasWord(before, 'Cut'), `BEFORE menu should OCR "Cut"; got: ${before}`);
		assert.ok(hasWord(before, 'Paste'), `BEFORE menu should OCR "Paste" (OCR sanity); got: ${before}`);

		// --- Enable via the command palette ---
		await paletteRun(page, 'Enable Custom Context Menu');
		await page.waitForTimeout(4000);
		const patched = findFiles(workbenchRoots, 'workbench.html')
			.some(w => { try { return fs.readFileSync(w, 'utf8').includes(PATCH_MARKER); } catch { return false; } });
		assert.ok(patched,
			'enabling should patch the desktop workbench.html on disk (the install dir must be writable; run as root).');

		// --- Reload the window so the patched workbench takes effect ---
		await paletteRun(page, 'Developer: Reload Window');
		await page.waitForTimeout(6000);
		try {
			await page.waitForSelector('.monaco-workbench', { timeout: 60000 });
		} catch {
			page = app.windows()[app.windows().length - 1];
			await page.waitForSelector('.monaco-workbench', { timeout: 60000 });
		}
		await page.waitForTimeout(8000);

		// --- After enabling: Copy/Cut gone, Paste + Command Palette remain ---
		const after = await desktopOpenMenuOcr(page, shot('after-full'), shot('after-menu'), ocr);
		t.diagnostic(`[vscode] after OCR: ${JSON.stringify(after)}`);
		t.diagnostic(`[vscode] after screenshots: ${shot('after-menu')} | ${shot('after-full')}`);
		assert.ok(hasWord(after, 'Paste'), `AFTER menu should still OCR "Paste"; got: ${after}`);
		assert.ok(/command palette/i.test(after), `AFTER menu should still OCR "Command Palette"; got: ${after}`);
		assert.ok(!hasWord(after, 'Copy'), `Copy should be GONE from the menu after enabling; OCR: ${after}`);
		assert.ok(!hasWord(after, 'Cut'), `Cut should be GONE from the menu after enabling; OCR: ${after}`);
	} finally {
		if (app) await app.close().catch(() => {});
		restoreWorkbenches(workbenchRoots, m => t.diagnostic(`[vscode] ${m}`));
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// ---- Entry point -----------------------------------------------------------

test('extension hides configured items in real editor menus', { timeout: 1800000 }, async (t) => {
	const screenshotDir = process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), 'ccm-e2e-screenshots');
	fs.mkdirSync(screenshotDir, { recursive: true });

	const csBin = resolveBin('CODE_SERVER_BIN', 'code-server');
	const vcBin = resolveBin('VSCODE_BIN', 'code');
	if (!csBin && !vcBin) {
		throw new Error(
			'No editor target was found. This e2e test needs at least one of code-server or desktop VS Code,\n' +
			'and installs neither. Install code-server (https://coder.com/docs/code-server/install) and/or VS Code,\n' +
			'or point CODE_SERVER_BIN / VSCODE_BIN at existing binaries, then re-run `npm run test:e2e`.'
		);
	}
	requireDisplay();
	resolveVsix(); // build (or locate) the .vsix once, up front; errors w/ instructions
	t.diagnostic('targets: ' + [csBin && 'code-server', vcBin && 'vscode'].filter(Boolean).join(', '));
	t.diagnostic('screenshots: ' + screenshotDir);

	if (csBin) {
		await t.test('target: code-server', { timeout: 540000 }, async (st) => {
			const chromiumBin = resolveChromium();
			const { chromium } = resolvePlaywright();
			await runCodeServerFlow(st, csBin, { chromium, chromiumBin, screenshotDir });
		});
	}
	if (vcBin) {
		await t.test('target: vscode', { timeout: 600000 }, async (st) => {
			await runDesktopFlow(st, vcBin, { screenshotDir });
		});
	}
});
