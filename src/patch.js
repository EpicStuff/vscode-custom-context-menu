'use strict';

const fs = require('fs');
const path = require('path');
const { safeWriteFile, safeRename } = require('./elevation');

const START_MARKER = '<!-- !! VSCODE-CUSTOM-CSS-START !! -->';
const END_MARKER = '<!-- !! VSCODE-CUSTOM-CSS-END !! -->';
const LEGACY_BACKUP_RE = /^workbench\.[\w-]+\.bak-custom-css$/;

// ---- Pure HTML transforms (no I/O) ----------------------------------------

function isPatched(html) {
	return html.includes(START_MARKER);
}

function clearExistingPatches(html) {
	html = html.replace(
		/<!-- !! VSCODE-CUSTOM-CSS-START !! -->[\s\S]*?<!-- !! VSCODE-CUSTOM-CSS-END !! -->\n*/,
		''
	);
	// Strip the legacy session-id marker so reconstructed backups stay clean.
	html = html.replace(/<!-- !! VSCODE-CUSTOM-CSS-SESSION-ID [\w-]+ !! -->\n*/g, '');
	// Re-enable any CSP meta tag we previously disabled by renaming.
	html = html.replace(/<meta-ccm-disabled\b/g, '<meta');
	return html;
}

// Neuter VSCode's CSP so our inline <script> can run, reversibly: rather than
// deleting the meta tag we rename it. The browser ignores <meta-ccm-disabled …>
// as an unknown element; clearExistingPatches restores the original <meta>.
function disableCspMetaTag(html) {
	return html.replace(
		/<meta\b([^>]*http-equiv=(?:"|')Content-Security-Policy(?:"|')[^>]*)>/gi,
		'<meta-ccm-disabled$1>'
	);
}

// Produce the patched workbench HTML from pristine HTML + an injected <script>.
function buildPatchedHtml(pristineHtml, injectedScript) {
	const html = disableCspMetaTag(pristineHtml);
	return html.replace(
		/(<\/html>)/,
		`${START_MARKER}\n${injectedScript}${END_MARKER}\n</html>`
	);
}

// ---- Backup / patch orchestration (I/O) -----------------------------------

function createPatcher({ htmlFile, backupFile, workbenchDir }) {
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
		const legacy = entries.filter(n => LEGACY_BACKUP_RE.test(n));
		if (legacy.length === 0) return;

		let preferred = null;
		try {
			const html = fs.readFileSync(htmlFile, 'utf-8');
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

	// Guarantee backupFile holds the pristine workbench.html.
	// - If workbench.html still carries our markers it is already patched: trust
	//   an existing backup, otherwise reconstruct one by stripping the markers.
	// - Otherwise it is a first install or VSCode was upgraded over our patch;
	//   either way the current contents are the new pristine state.
	async function ensureBackup() {
		const html = await fs.promises.readFile(htmlFile, 'utf-8');
		if (isPatched(html)) {
			if (!fs.existsSync(backupFile)) {
				await safeWriteFile(backupFile, clearExistingPatches(html));
			}
		} else {
			await safeWriteFile(backupFile, html);
		}
	}

	async function applyPatch(injectedScript) {
		const pristine = await fs.promises.readFile(backupFile, 'utf-8');
		await safeWriteFile(htmlFile, buildPatchedHtml(pristine, injectedScript));
	}

	async function removePatch() {
		if (!fs.existsSync(backupFile)) return;
		// One atomic rename consumes the backup and replaces workbench.html in a
		// single syscall — when this needs pkexec, it's a single auth prompt
		// instead of separate copy + unlink prompts.
		await safeRename(backupFile, htmlFile);
	}

	return { migrateLegacyBackups, ensureBackup, applyPatch, removePatch };
}

module.exports = {
	START_MARKER,
	END_MARKER,
	isPatched,
	clearExistingPatches,
	disableCspMetaTag,
	buildPatchedHtml,
	createPatcher,
};
