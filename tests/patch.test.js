'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
	isPatched,
	clearExistingPatches,
	disableCspMetaTag,
	buildPatchedHtml,
	createPatcher,
} = require('../src/patch');

const PRISTINE =
	'<html><head>' +
	'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">' +
	'</head><body>workbench</body></html>';

test('isPatched reflects the start marker', () => {
	assert.equal(isPatched(PRISTINE), false);
	assert.equal(isPatched(buildPatchedHtml(PRISTINE, '<script>1</script>')), true);
});

test('buildPatchedHtml injects the script before </html> and disables CSP', () => {
	const patched = buildPatchedHtml(PRISTINE, '<script>x</script>');
	assert.match(patched, /VSCODE-CUSTOM-CSS-START[\s\S]*<script>x<\/script>[\s\S]*VSCODE-CUSTOM-CSS-END !! -->\n<\/html>/);
	assert.match(patched, /<meta-ccm-disabled\b/);
	// No *active* CSP meta tag remains (the renamed one has a '-', not a space).
	assert.doesNotMatch(patched, /<meta\s[^>]*Content-Security-Policy/i);
});

test('clearExistingPatches restores pristine HTML (round-trip)', () => {
	const patched = buildPatchedHtml(PRISTINE, '<script>x</script>');
	assert.equal(clearExistingPatches(patched), PRISTINE);
});

test('clearExistingPatches strips the legacy session-id marker', () => {
	const withLegacy =
		'<html><body>x</body>\n<!-- !! VSCODE-CUSTOM-CSS-SESSION-ID abc-123 !! -->\n</html>';
	assert.doesNotMatch(clearExistingPatches(withLegacy), /SESSION-ID/);
});

test('disableCspMetaTag is reversible via clearExistingPatches', () => {
	const disabled = disableCspMetaTag(PRISTINE);
	assert.match(disabled, /<meta-ccm-disabled/);
	assert.equal(clearExistingPatches(disabled), PRISTINE);
});

test('createPatcher: backup, apply and remove round-trip on disk', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-test-'));
	const htmlFile = path.join(dir, 'workbench.html');
	const backupFile = htmlFile + '.orig';
	fs.writeFileSync(htmlFile, PRISTINE);
	const patcher = createPatcher({ htmlFile, backupFile, workbenchDir: dir });

	await patcher.ensureBackup();
	assert.equal(fs.readFileSync(backupFile, 'utf-8'), PRISTINE, 'backup captures pristine');

	await patcher.applyPatch('<script>hi</script>');
	const patched = fs.readFileSync(htmlFile, 'utf-8');
	assert.ok(isPatched(patched), 'workbench is patched');
	assert.match(patched, /<script>hi<\/script>/);

	await patcher.removePatch();
	assert.equal(fs.readFileSync(htmlFile, 'utf-8'), PRISTINE, 'remove restores pristine');
	assert.equal(fs.existsSync(backupFile), false, 'backup consumed by restore');

	fs.rmSync(dir, { recursive: true, force: true });
});

test('createPatcher: removePatch recovers when the backup is missing but the file is patched', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-test-'));
	const htmlFile = path.join(dir, 'workbench.html');
	const backupFile = htmlFile + '.orig';
	// Patched workbench, but the .orig backup was lost.
	fs.writeFileSync(htmlFile, buildPatchedHtml(PRISTINE, '<script>x</script>'));
	const patcher = createPatcher({ htmlFile, backupFile, workbenchDir: dir });

	await patcher.removePatch();
	assert.equal(fs.readFileSync(htmlFile, 'utf-8'), PRISTINE, 'patch stripped in place');
	assert.equal(isPatched(fs.readFileSync(htmlFile, 'utf-8')), false);

	fs.rmSync(dir, { recursive: true, force: true });
});

test('createPatcher: removePatch is a no-op on an unpatched file with no backup', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-test-'));
	const htmlFile = path.join(dir, 'workbench.html');
	const backupFile = htmlFile + '.orig';
	fs.writeFileSync(htmlFile, PRISTINE);
	const patcher = createPatcher({ htmlFile, backupFile, workbenchDir: dir });

	await patcher.removePatch();
	assert.equal(fs.readFileSync(htmlFile, 'utf-8'), PRISTINE, 'clean file left untouched');

	fs.rmSync(dir, { recursive: true, force: true });
});

test('createPatcher: ensureBackup reconstructs a clean backup from an already-patched file', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-test-'));
	const htmlFile = path.join(dir, 'workbench.html');
	const backupFile = htmlFile + '.orig';
	// Simulate VSCode having only the patched file (no backup yet).
	fs.writeFileSync(htmlFile, buildPatchedHtml(PRISTINE, '<script>old</script>'));
	const patcher = createPatcher({ htmlFile, backupFile, workbenchDir: dir });

	await patcher.ensureBackup();
	assert.equal(fs.readFileSync(backupFile, 'utf-8'), PRISTINE, 'backup is the de-patched pristine HTML');

	fs.rmSync(dir, { recursive: true, force: true });
});
