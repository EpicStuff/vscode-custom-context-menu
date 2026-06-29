const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const cp = require("child_process");
const msg = require("./messages").messages;

// #### Elevated file ops ######################################################
// VSCode installed under /opt or /usr is owned by root, so patching
// workbench.html fails with EACCES for an unprivileged user. On Linux we fall
// back to pkexec (polkit) which pops up the desktop's password dialog. The
// flow always tries the cheap unprivileged path first — pkexec only fires when
// the kernel actually says no, so user-installed VSCode pays nothing.

function isPermissionError(e) {
	return e && (e.code === "EACCES" || e.code === "EPERM" || e.code === "EROFS");
}

function canElevate() {
	return process.platform === "linux";
}

function pkexec(argv) {
	return new Promise((resolve, reject) => {
		const child = cp.spawn("pkexec", argv, { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		child.on("error", (e) => {
			if (e.code === "ENOENT") {
				reject(new Error("pkexec is not installed. Install polkit, or reinstall VSCode under a user-writable path."));
			} else {
				reject(e);
			}
		});
		child.on("exit", (code) => {
			if (code === 0) return resolve();
			if (code === 126) return reject(new Error("Polkit authentication was cancelled or failed."));
			if (code === 127) return reject(new Error("Polkit authorization was denied."));
			reject(new Error(`pkexec exited with code ${code}${stderr ? ": " + stderr.trim() : ""}`));
		});
	});
}

async function safeWriteFile(target, contents) {
	try {
		await fs.promises.writeFile(target, contents, "utf-8");
		return;
	} catch (e) {
		if (!isPermissionError(e) || !canElevate()) throw e;
	}
	const tmp = path.join(os.tmpdir(), `ccm-${crypto.randomBytes(8).toString("hex")}.tmp`);
	await fs.promises.writeFile(tmp, contents, "utf-8");
	try {
		await pkexec(["/bin/cp", "--", tmp, target]);
	} finally {
		try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
	}
}

async function safeRename(src, dst) {
	try {
		await fs.promises.rename(src, dst);
		return;
	} catch (e) {
		if (!isPermissionError(e) || !canElevate()) throw e;
	}
	await pkexec(["/bin/mv", "-f", "--", src, dst]);
}

function activate(context) {
	const config = vscode.workspace.getConfiguration("custom-contextmenu");
	const configuredWorkbenchPath = config.get("workbenchPath");
	const appDir = require.main
		? path.dirname(require.main.filename)
		: globalThis._VSCODE_FILE_ROOT;
	if (!appDir && !configuredWorkbenchPath) {
		vscode.window.showInformationMessage(msg.unableToLocateVsCodeInstallationPath);
	}

	const htmlFile = resolveWorkbenchHtmlFile(appDir, configuredWorkbenchPath);
	if (!htmlFile) {
		vscode.window.showInformationMessage(msg.unableToLocateVsCodeInstallationPath);
		return;
	}
	const workbenchDir = path.dirname(htmlFile);
	const backupFile = htmlFile + ".orig";
	const legacyBackupRe = /^workbench\.[\w-]+\.bak-custom-css$/;

	function resolveWorkbenchHtmlFile(appRoot, workbenchPath) {
		const baseCandidates = appRoot
			? [
					path.join(appRoot, "out", "vs", "code"),
					path.join(appRoot, "out", "vs", "workbench"),
					path.join(appRoot, "vs", "code"),
					path.join(appRoot, "vs", "workbench"),
			]
			: [];

		const htmlCandidates = [
			"workbench.html",
			"workbench.esm.html",
			path.join("electron-browser", "workbench", "workbench.html"),
			path.join("electron-browser", "workbench", "workbench.esm.html"),
			path.join("electron-sandbox", "workbench", "workbench.html"),
			path.join("electron-sandbox", "workbench", "workbench.esm.html"),
			// Web/server builds (code-server, VS Code Server, github.dev-style hosts)
			// serve the workbench from a `browser/workbench` directory instead of
			// the Electron `electron-*` ones.
			path.join("browser", "workbench", "workbench.html"),
			path.join("browser", "workbench", "workbench.esm.html"),
		];

		const resolveCandidate = basePath => {
			for (const candidate of htmlCandidates) {
				const candidatePath = path.join(basePath, candidate);
				if (fs.existsSync(candidatePath)) {
					return candidatePath;
				}
			}
			return null;
		};

		if (workbenchPath) {
			const resolvedPath = path.isAbsolute(workbenchPath)
				? workbenchPath
				: path.resolve(workbenchPath);
			if (fs.existsSync(resolvedPath)) {
				const stats = fs.statSync(resolvedPath);
				if (stats.isFile()) {
					return resolvedPath;
				}
				if (stats.isDirectory()) {
					const fromDirectory = resolveCandidate(resolvedPath);
					if (fromDirectory) {
						return fromDirectory;
					}
				}
			}
		}

		if (!appRoot) {
			return null;
		}

		for (const base of baseCandidates) {
			const resolved = resolveCandidate(base);
			if (resolved) {
				return resolved;
			}
		}
		return null;
	}

	// #### main commands ######################################################

	async function cmdInstall() {
		migrateLegacyBackups();
		await ensureBackup();
		await performPatch();
		enabledRestart();
	}

	async function cmdUninstall() {
		migrateLegacyBackups();
		await uninstallImpl();
		disabledRestart();
	}

	async function uninstallImpl() {
		if (!fs.existsSync(backupFile)) return;
		try {
			// One atomic rename consumes the backup and replaces workbench.html
			// in a single syscall — when this needs pkexec, it's a single auth
			// prompt instead of separate copy + unlink prompts.
			await safeRename(backupFile, htmlFile);
		} catch (e) {
			vscode.window.showInformationMessage(msg.admin);
			throw e;
		}
	}

	// #### Backup ################################################################

	// One-time migration from the old workbench.<uuid>.bak-custom-css scheme.
	// Picks the backup matching the SESSION-ID in the current workbench.html if
	// possible, otherwise the most recently modified one. Renames to .orig and
	// deletes the rest.
	function migrateLegacyBackups() {
		if (fs.existsSync(backupFile)) return;
		let entries;
		try {
			entries = fs.readdirSync(workbenchDir);
		} catch {
			return;
		}
		const legacy = entries.filter(n => legacyBackupRe.test(n));
		if (legacy.length === 0) return;

		let preferred = null;
		try {
			const html = fs.readFileSync(htmlFile, "utf-8");
			const m = html.match(/<!-- !! VSCODE-CUSTOM-CSS-SESSION-ID ([0-9a-fA-F-]+) !! -->/);
			if (m) {
				const matching = `workbench.${m[1]}.bak-custom-css`;
				if (legacy.includes(matching)) preferred = matching;
			}
		} catch { /* fall through */ }

		if (!preferred) {
			preferred = legacy
				.map(n => ({ n, t: fs.statSync(path.join(workbenchDir, n)).mtimeMs }))
				.sort((a, b) => b.t - a.t)[0].n;
		}

		try {
			fs.renameSync(path.join(workbenchDir, preferred), backupFile);
		} catch {
			return;
		}
		for (const n of legacy) {
			if (n === preferred) continue;
			try { fs.unlinkSync(path.join(workbenchDir, n)); } catch { /* ignore */ }
		}
	}

	// Guarantee backupFile contains the pristine workbench.html.
	//
	// - If the on-disk workbench.html still carries our START/END markers it is
	//   already patched. Trust an existing backup; otherwise reconstruct one by
	//   stripping the markers.
	// - If it does not, it is either a first-ever install or VSCode was just
	//   upgraded over our patched file. Either way the current contents are the
	//   new pristine state, so refresh the backup unconditionally.
	async function ensureBackup() {
		let html;
		try {
			html = await fs.promises.readFile(htmlFile, "utf-8");
		} catch (e) {
			vscode.window.showInformationMessage(msg.admin);
			throw e;
		}
		const isPatched = /<!-- !! VSCODE-CUSTOM-CSS-START !! -->/.test(html);
		try {
			if (isPatched) {
				if (!fs.existsSync(backupFile)) {
					await safeWriteFile(backupFile, clearExistingPatches(html));
				}
			} else {
				await safeWriteFile(backupFile, html);
			}
		} catch (e) {
			vscode.window.showInformationMessage(msg.admin);
			throw e;
		}
	}

	// #### Patching ##############################################################

	async function performPatch() {
		let html;
		try {
			html = await fs.promises.readFile(backupFile, "utf-8");
		} catch (e) {
			vscode.window.showInformationMessage(msg.admin);
			throw e;
		}
		html = disableCspMetaTag(html);
		const injectHTML = await patchScript();
		html = html.replace(
			/(<\/html>)/,
			"<!-- !! VSCODE-CUSTOM-CSS-START !! -->\n" +
				injectHTML +
				"<!-- !! VSCODE-CUSTOM-CSS-END !! -->\n</html>"
		);
		try {
			await safeWriteFile(htmlFile, html);
		} catch (e) {
			vscode.window.showInformationMessage(msg.admin);
			disabledRestart();
		}
	}

	function clearExistingPatches(html) {
		html = html.replace(
			/<!-- !! VSCODE-CUSTOM-CSS-START !! -->[\s\S]*?<!-- !! VSCODE-CUSTOM-CSS-END !! -->\n*/,
			""
		);
		// Strip the legacy session-id marker so reconstructed backups stay clean.
		html = html.replace(/<!-- !! VSCODE-CUSTOM-CSS-SESSION-ID [\w-]+ !! -->\n*/g, "");
		// Re-enable any CSP meta tag we previously disabled by renaming.
		html = html.replace(/<meta-ccm-disabled\b/g, "<meta");
		return html;
	}

	// We need to neuter VSCode's CSP so our inline <script> can run, but we want
	// the change to be reversible — so rather than deleting the meta tag we just
	// rename it. The browser ignores <meta-ccm-disabled ...> as an unknown
	// element; clearExistingPatches restores the original <meta> on disable or
	// when reconstructing the backup from a patched workbench.html.
	function disableCspMetaTag(html) {
		return html.replace(
			/<meta\b([^>]*http-equiv=(?:"|')Content-Security-Policy(?:"|')[^>]*)>/gi,
			"<meta-ccm-disabled$1>"
		);
	}

	async function patchScript() {
		const fileUri = vscode.Uri.joinPath(context.extensionUri, 'src', 'static', 'user.js');
		let fileContent
		try {
			fileContent = await fs.promises.readFile(fileUri.fsPath, 'utf8');
		} catch (error) {
			vscode.window.showErrorMessage(`Error reading file: ${error.message}`);
		}
		const config = vscode.workspace.getConfiguration('custom-contextmenu');
		const selectors = config.get('selectors');
		const normalizedSelectors = Array.isArray(selectors) ? selectors : [];
		const formattedSelectors = normalizedSelectors
			.filter((selector) => typeof selector === 'string')
			.map((selector) => formatSelector(selector));
		fileContent = fileContent.replace(
			'%selectors%',
			JSON.stringify(formattedSelectors)
		);
		return `<script>${fileContent}</script>`;
	}

	function formatSelector(selector) {
		const trimmed = selector.trim();
		if (!trimmed) {
			return trimmed;
		}
		if (trimmed.includes('"')) {
			return trimmed;
		}
		if (trimmed === "_") {
			return '"_"';
		}
		const separatorBeforeMatch = trimmed.match(/^_:\s*has\(\s*\+\s*(.+?)\s*\)$/);
		if (separatorBeforeMatch) {
			return `"_":has( + ${quoteLabel(separatorBeforeMatch[1])})`;
		}
		const separatorAfterMatch = trimmed.match(/^(.+?)\s*\+\s*_$/);
		if (separatorAfterMatch) {
			return `${quoteLabel(separatorAfterMatch[1])} + "_"`;
		}
		return quoteLabel(trimmed);
	}

	function quoteLabel(label) {
		const trimmed = label.trim();
		if (trimmed.startsWith("^")) {
			return `^"${trimmed.slice(1)}"`;
		}
		return `"${trimmed}"`;
	}

	function reloadWindow() {
		// reload vscode-window
		vscode.commands.executeCommand("workbench.action.reloadWindow");
	}
	function enabledRestart() {
		vscode.window
			.showInformationMessage(msg.enabled, msg.restartIde)
			.then((btn) => {
				// if close button is clicked btn is undefined, so no reload window
				if (btn === msg.restartIde) {
					reloadWindow()
				}
			})
	}
	function disabledRestart() {
		vscode.window
			.showInformationMessage(msg.disabled, msg.restartIde)
			.then((btn) => {
				if (btn === msg.restartIde) {
					reloadWindow()
				}
			})
	}

	const installCustomCSS = vscode.commands.registerCommand(
		"custom-contextmenu.installCustomContextmenu",
		cmdInstall
	);
	const uninstallCustomCSS = vscode.commands.registerCommand(
		"custom-contextmenu.uninstallCustomContextmenu",
		cmdUninstall
	);
	const configChangeHandler = vscode.workspace.onDidChangeConfiguration((event) => {
		if (!event.affectsConfiguration("custom-contextmenu.selectors")) {
			return;
		}
		vscode.window
			.showInformationMessage(
				"Custom context menu selectors updated. Re-enable the custom context menu to apply changes.",
				"Re-enable"
			)
			.then((btn) => {
				if (btn === "Re-enable") {
					vscode.commands.executeCommand(
						"custom-contextmenu.installCustomContextmenu"
					);
				}
			});
	});

	context.subscriptions.push(installCustomCSS);
	context.subscriptions.push(uninstallCustomCSS);
	context.subscriptions.push(configChangeHandler);

	console.log("vscode-custom-css is active!");
	console.log("Application directory", appDir);
	console.log("Main HTML file", htmlFile);
}
exports.activate = activate;

// Note: we deliberately do not auto-uninstall on deactivate. Extension
// deactivation fires on every window reload (including the reload triggered
// by Enable itself), and uninstalling there means a single Enable would
// take effect for only one window load. The user must run "Disable Custom
// Context Menu" explicitly to revert.
function deactivate() {}
exports.deactivate = deactivate;
