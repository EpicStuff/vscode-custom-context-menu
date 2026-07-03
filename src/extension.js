const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const msg = require("./messages").messages;
const { resolveWorkbenchHtmlFile } = require("./workbench");
const { parseSelectors, selectorsToCss } = require("./selectors");
const patchlib = require("./patch");
const elevation = require("./elevation");

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
	const patcher = patchlib.createPatcher({ htmlFile, backupFile, workbenchDir });

	// Read user.js, bake in the parsed selectors and generated CSS, wrap in a
	// <script>. The selectors are injected pre-parsed (structured) for the menu
	// runtime's separator pass; the CSS hides labelled items before VSCode
	// measures the menu. Function replacements avoid `$` in the JSON/CSS being
	// treated as a replacement pattern.
	async function buildInjectedScript() {
		const templatePath = vscode.Uri.joinPath(context.extensionUri, "src", "static", "user.js").fsPath;
		const template = await fs.promises.readFile(templatePath, "utf8");
		const parsed = parseSelectors(config.get("selectors"));
		const css = selectorsToCss(parsed);
		const body = template
			.replace("%selectors%", () => JSON.stringify(parsed))
			.replace("%css%", () => JSON.stringify(css));
		return `<script>${body}</script>`;
	}

	async function cmdInstall() {
		try {
			patcher.migrateLegacyBackups();
			await patcher.ensureBackup();
			await patcher.applyPatch(await buildInjectedScript());
			await context.globalState.update("enabled", true);
			enabledRestart();
		} catch (e) {
			handleWriteError(e);
		}
	}

	async function cmdUninstall() {
		try {
			patcher.migrateLegacyBackups();
			await patcher.removePatch();
			await context.globalState.update("enabled", false);
			disabledRestart();
		} catch (e) {
			handleWriteError(e);
		}
	}

	// A privileged write failed. If it was a permission problem the elevation
	// path couldn't resolve (e.g. headless code-server with no polkit agent for
	// pkexec), fall back to granting the current user write access via a POSIX
	// ACL — scoped to that one user, unlike a chmod that opens the files to
	// everyone. The command is placed in a terminal for the user to review and
	// run with their sudo password; they then re-run Enable.
	function handleWriteError(e) {
		if (e && e.needsPermissionFix) {
			const q = s => `'${String(s).replace(/'/g, "'\\''")}'`;
			const terminal = vscode.window.createTerminal("Custom Context Menu");
			terminal.show();
			terminal.sendText(
				`sudo setfacl -m u:$(whoami):rwX ${q(workbenchDir)} ${q(htmlFile)}`,
				false
			);
			vscode.window.showInformationMessage(msg.terminalPermissionFix);
			return;
		}
		// Only genuine permission failures get the "run as admin" advice. Anything
		// else — a missing/unreadable user.js template, a bad workbench path, an
		// unexpected patch failure — surfaces its real message so it isn't
		// mislabelled as a permission problem the user can't actually fix that way.
		if (elevation.isPermissionError(e)) {
			vscode.window.showInformationMessage(msg.admin);
			return;
		}
		vscode.window.showErrorMessage(msg.somethingWrong + (e && e.message ? e.message : String(e)));
	}

	function reloadWindow() {
		vscode.commands.executeCommand("workbench.action.reloadWindow");
	}
	function promptReload(message) {
		vscode.window.showInformationMessage(message, msg.restartIde).then((btn) => {
			// btn is undefined when the notification is dismissed — don't reload then.
			if (btn === msg.restartIde) reloadWindow();
		});
	}
	function enabledRestart() { promptReload(msg.enabled); }
	function disabledRestart() { promptReload(msg.disabled); }

	function promptReEnable(message) {
		vscode.window.showInformationMessage(message, msg.reEnable).then((btn) => {
			if (btn === msg.reEnable) {
				vscode.commands.executeCommand("custom-contextmenu.installCustomContextmenu");
			}
		});
	}

	// A VSCode update overwrites workbench.html, silently wiping our patch. If the
	// user had it enabled, detect the now-pristine file on startup and offer to
	// re-apply (rather than silently triggering an elevation prompt).
	if (context.globalState.get("enabled")) {
		let current = "";
		try { current = fs.readFileSync(htmlFile, "utf-8"); } catch { /* ignore */ }
		if (current && !patchlib.isPatched(current)) {
			promptReEnable(msg.reapplyAfterUpdate);
		}
	}

	context.subscriptions.push(
		vscode.commands.registerCommand("custom-contextmenu.installCustomContextmenu", cmdInstall),
		vscode.commands.registerCommand("custom-contextmenu.uninstallCustomContextmenu", cmdUninstall),
		vscode.workspace.onDidChangeConfiguration((event) => {
			// Only nag about re-enabling when the patch is actually in place —
			// otherwise editing selectors before ever enabling triggers an
			// irrelevant prompt.
			if (event.affectsConfiguration("custom-contextmenu.selectors")
				&& context.globalState.get("enabled")) {
				promptReEnable(msg.selectorsChanged);
			}
		})
	);

	console.log("custom-contextmenu active. Workbench file:", htmlFile);
}
exports.activate = activate;

// Note: we deliberately do not auto-uninstall on deactivate. Extension
// deactivation fires on every window reload (including the reload triggered
// by Enable itself), and uninstalling there means a single Enable would
// take effect for only one window load. The user must run "Disable Custom
// Context Menu" explicitly to revert.
function deactivate() {}
exports.deactivate = deactivate;
