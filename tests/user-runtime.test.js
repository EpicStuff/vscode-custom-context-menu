'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The injected runtime (src/static/user.js) carries %selectors%/%css%
// placeholders and runs as a browser <script>. Fill the placeholders with inert
// values and require it under Node: with no `document`, it skips the DOM
// bootstrap and exports its pure separator-decision core instead.
function loadRuntime() {
	const template = fs.readFileSync(
		path.join(__dirname, '..', 'src', 'static', 'user.js'), 'utf8');
	const body = template
		.replace('%selectors%', () => '[]')
		.replace('%css%', () => '""');
	const file = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-runtime-')), 'user.runtime.js');
	fs.writeFileSync(file, body);
	return require(file);
}

const { computeSeparatorHides } = loadRuntime();

// Convenience: build the parallel arrays from a compact item list. A separator
// is `{ sep: true }`; a command is `{ label, cssHidden? }`.
function hidesFor(items, selectors = []) {
	const seps = items.map(it => !!it.sep);
	const labels = items.map(it => it.label || '');
	const cssHidden = items.map(it => !!it.cssHidden);
	return computeSeparatorHides(seps, labels, cssHidden, selectors);
}

const SEP = { sep: true };

test('trims a trailing separator', () => {
	assert.deepEqual(
		hidesFor([{ label: 'Copy' }, SEP, { label: 'Paste' }, SEP]),
		[false, false, false, true]);
});

test('trims a leading separator', () => {
	assert.deepEqual(
		hidesFor([SEP, { label: 'Copy' }]),
		[true, false]);
});

test('collapses adjacent separators to one', () => {
	assert.deepEqual(
		hidesFor([{ label: 'A' }, SEP, SEP, { label: 'B' }]),
		[false, false, true, false]);
});

test('keeps a lone separator between two visible commands', () => {
	assert.deepEqual(
		hidesFor([{ label: 'A' }, SEP, { label: 'B' }]),
		[false, false, false]);
});

test("'sep' selector hides every separator", () => {
	assert.deepEqual(
		hidesFor([{ label: 'A' }, SEP, { label: 'B' }], [{ kind: 'sep' }]),
		[false, true, false]);
});

test("'sep-after' hides the separator following a matched label", () => {
	assert.deepEqual(
		hidesFor(
			[{ label: 'Copy' }, SEP, { label: 'Paste' }],
			[{ kind: 'sep-after', prefix: false, label: 'Copy' }]),
		[false, true, false]);
});

test("'sep-before' hides the separator preceding a matched label", () => {
	assert.deepEqual(
		hidesFor(
			[{ label: 'Copy' }, SEP, { label: 'Paste' }],
			[{ kind: 'sep-before', prefix: false, label: 'Paste' }]),
		[false, true, false]);
});

test("'sep-after' honours prefix matching", () => {
	assert.deepEqual(
		hidesFor(
			[{ label: 'Go to Definition' }, SEP, { label: 'Copy' }],
			[{ kind: 'sep-after', prefix: true, label: 'Go to' }]),
		[false, true, false]);
});

test('a command hidden by CSS lets its now-stranded separator be trimmed', () => {
	// Paste is hidden by our label CSS, so the separator before it is trailing.
	assert.deepEqual(
		hidesFor([{ label: 'Copy' }, SEP, { label: 'Paste', cssHidden: true }]),
		[false, true, false]);
});

test('a self-selector command collapses its separators before the sheet paints', () => {
	// First-open race: our label CSS will hide B, but on the very first menu the
	// injected stylesheet may not have painted yet, so getComputedStyle reports B
	// visible (cssHidden:false everywhere). The collapse must still fold the two
	// separators flanking B into one from the self selector alone — otherwise the
	// menu shows stacked separators until the next open warms the sheet.
	assert.deepEqual(
		hidesFor(
			[{ label: 'A' }, SEP, { label: 'B' }, SEP, { label: 'C' }],
			[{ kind: 'self', prefix: false, label: 'B' }]),
		[false, false, false, true, false]);
});

test('a self prefix selector also collapses before paint', () => {
	assert.deepEqual(
		hidesFor(
			[{ label: 'A' }, SEP, { label: 'Go to Definition' }, SEP, { label: 'C' }],
			[{ kind: 'self', prefix: true, label: 'Go to' }]),
		[false, false, false, true, false]);
});

test('empty menu yields no hides', () => {
	assert.deepEqual(hidesFor([]), []);
});
