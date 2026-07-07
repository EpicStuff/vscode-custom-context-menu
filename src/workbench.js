'use strict';

const fs = require('fs');
const path = require('path');

// Sub-directories of the app root where the workbench is laid out, in priority
// order.
const BASE_SUBDIRS = [
	['out', 'vs', 'code'],
	['out', 'vs', 'workbench'],
	['vs', 'code'],
	['vs', 'workbench'],
];

// Candidate workbench HTML paths relative to a base directory. Electron desktop
// builds use the `electron-*` directories; web/server builds (code-server,
// VS Code Server, github.dev-style hosts) serve it from `browser/workbench`.
const HTML_CANDIDATES = [
	'workbench.html',
	'workbench.esm.html',
	path.join('electron-browser', 'workbench', 'workbench.html'),
	path.join('electron-browser', 'workbench', 'workbench.esm.html'),
	path.join('electron-sandbox', 'workbench', 'workbench.html'),
	path.join('electron-sandbox', 'workbench', 'workbench.esm.html'),
	path.join('browser', 'workbench', 'workbench.html'),
	path.join('browser', 'workbench', 'workbench.esm.html'),
];

function firstExistingCandidate(basePath) {
	for (const candidate of HTML_CANDIDATES) {
		const candidatePath = path.join(basePath, candidate);
		if (fs.existsSync(candidatePath)) return candidatePath;
	}
	return null;
}

// Locate VSCode's workbench HTML file. A user-configured `workbenchPath` (a file
// or a directory to search) takes precedence; otherwise probe the known layouts
// under the detected app root. Returns the absolute path or null.
function resolveWorkbenchHtmlFile(appRoot, workbenchPath) {
	if (workbenchPath) {
		const resolved = path.isAbsolute(workbenchPath) ? workbenchPath : path.resolve(workbenchPath);
		if (fs.existsSync(resolved)) {
			const stats = fs.statSync(resolved);
			if (stats.isFile()) return resolved;
			if (stats.isDirectory()) {
				const fromDirectory = firstExistingCandidate(resolved);
				if (fromDirectory) return fromDirectory;
			}
		}
	}

	if (!appRoot) return null;

	for (const sub of BASE_SUBDIRS) {
		const resolved = firstExistingCandidate(path.join(appRoot, ...sub));
		if (resolved) return resolved;
	}
	return null;
}

module.exports = { resolveWorkbenchHtmlFile, HTML_CANDIDATES, BASE_SUBDIRS };
