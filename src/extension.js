const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
const msg = require("./messages").messages;
const uuid = require("uuid");

const execFileAsync = promisify(execFile);

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

	// ####  main commands ######################################################

	async function cmdInstall() {
		const uuidSession = uuid.v4();
		console.log("context menu", "enable")
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
			await writeFileWithFallback(BackupFilePath(uuidSession), html);
		} catch (e) {
			vscode.window.showInformationMessage(msg.admin);
			throw e;
		}
	}

	async function restoreBackup(backupFilePath) {
		try {
			if (fs.existsSync(backupFilePath)) {
				await deleteFileWithFallback(htmlFile);
				await copyFileWithFallback(backupFilePath, htmlFile);
			}
		} catch (e) {
			vscode.window.showInformationMessage(msg.admin);
			throw e;
		}
	}

	async function deleteBackupFiles() {
		const htmlDir = path.dirname(htmlFile);
		const htmlDirItems = await fs.promises.readdir(htmlDir);
		const elevatedDeletes = [];
		for (const item of htmlDirItems) {
			if (item.endsWith(".bak-custom-css")) {
				const filePath = path.join(htmlDir, item);
				try {
					await fs.promises.unlink(filePath);
				} catch (error) {
					if (!isPermissionError(error)) {
						throw error;
					}
					elevatedDeletes.push(filePath);
				}
			}
		}
		if (elevatedDeletes.length > 0) {
			await runElevatedCommand("rm", ["-f", ...elevatedDeletes]);
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
			await writeFileWithFallback(htmlFile, html);
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

	function isPermissionError(error) {
		return error && (error.code === "EACCES" || error.code === "EPERM");
	}

	async function runElevatedCommand(command, args) {
		if (process.platform !== "linux") {
			const error = new Error("Elevated write is only supported on Linux.");
			error.code = "UNSUPPORTED_PLATFORM";
			throw error;
		}
		await execFileAsync("pkexec", [command, ...args]);
	}

	async function writeFileWithElevated(filePath, content) {
		const tempDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), "vscode-custom-contextmenu-")
		);
		const tempFilePath = path.join(tempDir, path.basename(filePath));
		try {
			await fs.promises.writeFile(tempFilePath, content, "utf-8");
			await runElevatedCommand("cp", [tempFilePath, filePath]);
		} finally {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		}
	}

	async function writeFileWithFallback(filePath, content) {
		try {
			await fs.promises.writeFile(filePath, content, "utf-8");
		} catch (error) {
			if (!isPermissionError(error)) {
				throw error;
			}
			await writeFileWithElevated(filePath, content);
		}
	}

	async function copyFileWithFallback(sourcePath, targetPath) {
		try {
			await fs.promises.copyFile(sourcePath, targetPath);
		} catch (error) {
			if (!isPermissionError(error)) {
				throw error;
			}
			await runElevatedCommand("cp", [sourcePath, targetPath]);
		}
	}

	async function deleteFileWithFallback(filePath) {
		try {
			await fs.promises.unlink(filePath);
		} catch (error) {
			if (!isPermissionError(error)) {
				throw error;
			}
			await runElevatedCommand("rm", ["-f", filePath]);
		}
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

// this method is called when your extension is deactivated
function deactivate() {
vscode.commands.executeCommand("custom-contextmenu.uninstallCustomContextmenu")
}
exports.deactivate = deactivate;
