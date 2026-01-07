const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const msg = require("./messages").messages;
const uuid = require("uuid");

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
	const BackupFilePath = uuid => path.join(workbenchDir, `workbench.${uuid}.bak-custom-css`);

	function resolveWorkbenchHtmlFile(appRoot, workbenchPath) {
		const htmlCandidates = [
			path.join("electron-sandbox", "workbench", "workbench.html"),
			path.join("electron-sandbox", "workbench", "workbench.esm.html"),
			"workbench.html",
			"workbench.esm.html",
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

		const base = path.join(appRoot, "vs", "code");
		return resolveCandidate(base);
	}

	// ####  main commands ######################################################

	async function cmdInstall() {
		const uuidSession = uuid.v4();
		console.log("contextmenu", "enable")
		await createBackup(uuidSession);
		await performPatch(uuidSession);
		enabledRestart();
	}

	async function cmdUninstall() {
		await uninstallImpl();
		disabledRestart();
	}

	async function uninstallImpl() {
		const backupUuid = await getBackupUuid(htmlFile);
		if (!backupUuid) return;
		const backupPath = BackupFilePath(backupUuid);
		await restoreBackup(backupPath);
		await deleteBackupFiles();
	}

	// #### Backup ################################################################

	async function getBackupUuid(htmlFilePath) {
		try {
			const htmlContent = await fs.promises.readFile(htmlFilePath, "utf-8");
			const m = htmlContent.match(
				/<!-- !! VSCODE-CUSTOM-CSS-SESSION-ID ([0-9a-fA-F-]+) !! -->/
			);
			if (!m) return null;
			else return m[1];
		} catch (e) {
			vscode.window.showInformationMessage(msg.somethingWrong + e);
			throw e;
		}
	}

	async function createBackup(uuidSession) {
		try {
			let html = await fs.promises.readFile(htmlFile, "utf-8");
			html = clearExistingPatches(html);
			await fs.promises.writeFile(BackupFilePath(uuidSession), html, "utf-8");
		} catch (e) {
			vscode.window.showInformationMessage(msg.admin);
			throw e;
		}
	}

	async function restoreBackup(backupFilePath) {
		try {
			if (fs.existsSync(backupFilePath)) {
				await fs.promises.unlink(htmlFile);
				await fs.promises.copyFile(backupFilePath, htmlFile);
			}
		} catch (e) {
			vscode.window.showInformationMessage(msg.admin);
			throw e;
		}
	}

	async function deleteBackupFiles() {
		const htmlDir = path.dirname(htmlFile);
		const htmlDirItems = await fs.promises.readdir(htmlDir);
		for (const item of htmlDirItems) {
			if (item.endsWith(".bak-custom-css")) {
				await fs.promises.unlink(path.join(htmlDir, item));
			}
		}
	}

	// #### Patching ##############################################################

	async function performPatch(uuidSession) {
		let html = await fs.promises.readFile(htmlFile, "utf-8");
		html = clearExistingPatches(html);

		const injectHTML = await patchScript();
		html = removeCspMetaTag(html);

		html = html.replace(
			/(<\/html>)/,
			`<!-- !! VSCODE-CUSTOM-CSS-SESSION-ID ${uuidSession} !! -->\n` +
				"<!-- !! VSCODE-CUSTOM-CSS-START !! -->\n" +
				injectHTML +
				"<!-- !! VSCODE-CUSTOM-CSS-END !! -->\n</html>"
		);
		try {
			await fs.promises.writeFile(htmlFile, html, "utf-8");
		} catch (e) {
			vscode.window.showInformationMessage(msg.admin);
			disabledRestart();
			return
		}
	}
	function clearExistingPatches(html) {
		html = html.replace(
			/<!-- !! VSCODE-CUSTOM-CSS-START !! -->[\s\S]*?<!-- !! VSCODE-CUSTOM-CSS-END !! -->\n*/,
			""
		);
		html = html.replace(/<!-- !! VSCODE-CUSTOM-CSS-SESSION-ID [\w-]+ !! -->\n*/g, "");
		return html;
	}

	function removeCspMetaTag(html) {
		return html.replace(
			/<meta\b[^>]*http-equiv=(?:"|')Content-Security-Policy(?:"|')[^>]*>/gi,
			""
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
		const showGoTos = config.get('showGoTos');
		const showClipboardItems = config.get('showClipboardItems');
		fileContent = fileContent.replace('%showGoTos%', showGoTos);
		fileContent = fileContent.replace('%showClipboardItems%', showClipboardItems);
		return `<script>${fileContent}</script>`;
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

	context.subscriptions.push(installCustomCSS);
	context.subscriptions.push(uninstallCustomCSS);

	console.log("vscode-custom-css is active!");
	console.log("Application directory", appDir);
	console.log("Main HTML file", htmlFile);
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
	vscode.commands.executeCommand("custom-contextmenu.uninstallCustomContextmenu")
}
exports.deactivate = deactivate;
