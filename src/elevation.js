'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');

// Elevated file ops. VSCode installed under /opt or /usr is owned by root, so
// patching workbench.html fails with EACCES for an unprivileged user. On Linux
// we fall back to pkexec (polkit), which pops the desktop's password dialog.
// The flow always tries the cheap unprivileged path first — pkexec only fires
// when the kernel actually says no, so user-installed VSCode pays nothing. When
// pkexec itself is unavailable (e.g. headless code-server with no polkit agent)
// the error is tagged `needsPermissionFix` so the caller can offer the setfacl
// terminal fallback.

function isPermissionError(e) {
	return e && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS');
}

function canElevate() {
	return process.platform === 'linux';
}

function pkexec(argv) {
	return new Promise((resolve, reject) => {
		const child = cp.spawn('pkexec', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stderr = '';
		child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
		child.on('error', (e) => {
			if (e.code === 'ENOENT') {
				reject(new Error('pkexec is not installed. Install polkit, or reinstall VSCode under a user-writable path.'));
			} else {
				reject(e);
			}
		});
		child.on('exit', (code) => {
			if (code === 0) return resolve();
			if (code === 126) return reject(new Error('Polkit authentication was cancelled or failed.'));
			if (code === 127) return reject(new Error('Polkit authorization was denied.'));
			reject(new Error(`pkexec exited with code ${code}${stderr ? ': ' + stderr.trim() : ''}`));
		});
	});
}

async function safeWriteFile(target, contents) {
	try {
		await fs.promises.writeFile(target, contents, 'utf-8');
		return;
	} catch (e) {
		if (!isPermissionError(e) || !canElevate()) throw e;
	}
	const tmp = path.join(os.tmpdir(), `ccm-${crypto.randomBytes(8).toString('hex')}.tmp`);
	await fs.promises.writeFile(tmp, contents, 'utf-8');
	try {
		await pkexec(['/bin/cp', '--', tmp, target]);
	} catch (e) {
		e.needsPermissionFix = true;
		throw e;
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
	try {
		await pkexec(['/bin/mv', '-f', '--', src, dst]);
	} catch (e) {
		e.needsPermissionFix = true;
		throw e;
	}
}

module.exports = { isPermissionError, canElevate, pkexec, safeWriteFile, safeRename };
