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

const { computeSeparatorHides, trimSeparators, menuContainersFor } = loadRuntime();

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

// ---- DOM-level behaviour, driven through minimal fake elements ----

function fakeStyle() {
	const props = {};
	return {
		props,
		setProperty(k, v) { props[k] = v; },
		removeProperty(k) { delete props[k]; },
	};
}

// A menu entry: a separator or a command. `cssHidden` models display:none that
// the injected label sheet applies to a command.
function fakeItem({ sep = false, label = '', cssHidden = false }) {
	const style = fakeStyle();
	const marker = sep ? { closest: () => item } : null;
	const item = {
		style,
		cssHidden,
		classList: { contains: () => false },
		getAttribute: () => null,
		contains: () => false,
		querySelector(sel) {
			if (sel === '.action-label') return { getAttribute: () => label, textContent: label };
			return marker;
		},
	};
	return item;
}

function fakeContainer(items) {
	return {
		matches: () => false,
		querySelectorAll: () => items,
	};
}

test('repeated passes keep a collapsed separator hidden', () => {
	global.getComputedStyle = (el) => ({
		display: el.style.props.display || (el.cssHidden ? 'none' : 'flex'),
		visibility: 'visible',
	});
	const items = [
		fakeItem({ label: 'Copy' }),
		fakeItem({ sep: true }),
		fakeItem({ label: 'Hidden', cssHidden: true }),
		fakeItem({ sep: true }),
		fakeItem({ label: 'Paste' }),
	];
	const container = fakeContainer(items);
	const sepDisplays = [];
	for (let pass = 0; pass < 4; pass++) {
		trimSeparators(container);
		sepDisplays.push(items.filter((_, i) => i % 2 === 1).map(el => el.style.props.display));
	}
	// Exactly one of the two stranded separators stays visible and the same one
	// is hidden on every pass.
	for (const d of sepDisplays) assert.deepEqual(d, sepDisplays[0]);
	assert.equal(sepDisplays[0].filter(v => v === 'none').length, 1);
});

test('finds a reused menu container that is an ancestor of the added node', () => {
	const container = { matches: (s) => s === '.monaco-menu-container' };
	const child = {
		nodeType: 1,
		matches: () => false,
		closest: (s) => (s === '.monaco-menu-container' ? container : null),
		querySelectorAll: () => [],
	};
	assert.deepEqual([...menuContainersFor(child)], [container]);
});

test('still finds the node itself and its descendants', () => {
	const inner = {};
	const node = {
		nodeType: 1,
		matches: (s) => s === '.monaco-menu-container',
		closest: () => null,
		querySelectorAll: () => [inner],
	};
	assert.deepEqual([...menuContainersFor(node)], [node, inner]);
});
