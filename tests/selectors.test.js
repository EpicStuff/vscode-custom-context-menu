'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSelector, parseSelectors, selectorsToCss } = require('../src/selectors');

test('parses a plain label as an exact self selector', () => {
	assert.deepEqual(parseSelector('Copy'), { kind: 'self', prefix: false, label: 'Copy' });
});

test('parses a ^ prefix selector', () => {
	assert.deepEqual(parseSelector('^Go to'), { kind: 'self', prefix: true, label: 'Go to' });
});

test('parses the bare separator placeholder', () => {
	assert.deepEqual(parseSelector('_'), { kind: 'sep' });
});

test('parses separator-before (hide sep before X)', () => {
	assert.deepEqual(parseSelector('_:has( + Share)'), { kind: 'sep-before', prefix: false, label: 'Share' });
});

test('parses separator-after (hide sep after X)', () => {
	assert.deepEqual(parseSelector('Share + _'), { kind: 'sep-after', prefix: false, label: 'Share' });
});

test('accepts the fully-quoted forms equivalently', () => {
	assert.deepEqual(parseSelector('"Copy"'), { kind: 'self', prefix: false, label: 'Copy' });
	assert.deepEqual(parseSelector('"_":has( + "Share")'), { kind: 'sep-before', prefix: false, label: 'Share' });
	assert.deepEqual(parseSelector('"Share" + "_"'), { kind: 'sep-after', prefix: false, label: 'Share' });
	assert.deepEqual(parseSelector('^"Go to"'), { kind: 'self', prefix: true, label: 'Go to' });
});

test('parseSelectors filters non-strings and empties', () => {
	const out = parseSelectors(['Copy', '', 42, null, '  ', '^Go to']);
	assert.deepEqual(out, [
		{ kind: 'self', prefix: false, label: 'Copy' },
		{ kind: 'self', prefix: true, label: 'Go to' },
	]);
});

test('parseSelectors tolerates non-array input', () => {
	assert.deepEqual(parseSelectors(undefined), []);
	assert.deepEqual(parseSelectors('Copy'), []);
});

test('selectorsToCss emits :has rules for self/prefix only', () => {
	const css = selectorsToCss(parseSelectors(['Copy', '^Go to', '_', 'Share + _']));
	assert.match(css, /\.action-item:has\(\.action-label\[aria-label="Copy"\]\)/);
	assert.match(css, /\.action-item:has\(\.action-label\[aria-label\^="Go to"\]\)/);
	assert.ok(css.endsWith('{ display: none !important; }'));
	// separator selectors are handled in JS, never in CSS
	assert.doesNotMatch(css, /Share/);
	assert.doesNotMatch(css, /\.separator/);
});

test('selectorsToCss returns empty string when no self selectors map to CSS', () => {
	assert.equal(selectorsToCss(parseSelectors(['_', 'Share + _', '_:has( + Cut)'])), '');
	assert.equal(selectorsToCss([]), '');
});

test('selectorsToCss emits both ellipsis variants', () => {
	const css = selectorsToCss(parseSelectors(['Command Palette...']));
	assert.match(css, /aria-label="Command Palette\.\.\."/);
	assert.match(css, /aria-label="Command Palette…"/);
});

test('selectorsToCss escapes quotes and backslashes in labels', () => {
	const css = selectorsToCss(parseSelectors(['Say "hi"']));
	assert.match(css, /aria-label="Say \\"hi\\""/);
});
