'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveWorkbenchHtmlFile } = require('../src/workbench');

function tmpdir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-wb-'));
}
function touch(file) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, '<html></html>');
}

test('finds the web/server browser layout under the app root', () => {
	const root = tmpdir();
	const wb = path.join(root, 'out', 'vs', 'code', 'browser', 'workbench', 'workbench.html');
	touch(wb);
	assert.equal(resolveWorkbenchHtmlFile(root), wb);
	fs.rmSync(root, { recursive: true, force: true });
});

test('finds the electron-sandbox desktop layout', () => {
	const root = tmpdir();
	const wb = path.join(root, 'out', 'vs', 'code', 'electron-sandbox', 'workbench', 'workbench.esm.html');
	touch(wb);
	assert.equal(resolveWorkbenchHtmlFile(root), wb);
	fs.rmSync(root, { recursive: true, force: true });
});

test('returns null when nothing matches', () => {
	const root = tmpdir();
	assert.equal(resolveWorkbenchHtmlFile(root), null);
	assert.equal(resolveWorkbenchHtmlFile(null), null);
	fs.rmSync(root, { recursive: true, force: true });
});

test('honours an explicit workbenchPath file over the app root', () => {
	const root = tmpdir();
	touch(path.join(root, 'out', 'vs', 'code', 'browser', 'workbench', 'workbench.html'));
	const override = path.join(root, 'custom', 'mybench.html');
	touch(override);
	assert.equal(resolveWorkbenchHtmlFile(root, override), override);
	fs.rmSync(root, { recursive: true, force: true });
});

test('honours a workbenchPath directory by probing candidates inside it', () => {
	const root = tmpdir();
	const wb = path.join(root, 'somewhere', 'workbench.html');
	touch(wb);
	assert.equal(resolveWorkbenchHtmlFile(null, path.join(root, 'somewhere')), wb);
	fs.rmSync(root, { recursive: true, force: true });
});

test('falls back to the app root when workbenchPath does not exist', () => {
	const root = tmpdir();
	const wb = path.join(root, 'out', 'vs', 'code', 'browser', 'workbench', 'workbench.html');
	touch(wb);
	assert.equal(resolveWorkbenchHtmlFile(root, '/no/such/path'), wb);
	fs.rmSync(root, { recursive: true, force: true });
});
