'use strict';

// Single source of truth for the context-menu selector grammar. Used by the
// extension to (a) generate the CSS that hides labelled items and (b) produce
// the structured selector list injected into the menu runtime for separator
// trimming. Kept dependency-free so it can be unit tested directly.
//
// Accepted forms (quotes optional everywhere):
//   Copy            -> { kind: 'self', prefix: false, label: 'Copy' }
//   ^Go to          -> { kind: 'self', prefix: true,  label: 'Go to' }
//   _               -> { kind: 'sep' }
//   _:has( + Share) -> { kind: 'sep-before', ...label of Share }  (sep before Share)
//   Share + _       -> { kind: 'sep-after',  ...label of Share }  (sep after Share)

function stripOuterQuotes(s) {
	const m = s.match(/^"(.*)"$/);
	return m ? m[1] : s;
}

function parseLabelOnly(s) {
	s = stripOuterQuotes(s.trim());
	const carat = s.match(/^\^(.+)$/);
	if (carat) return { prefix: true, label: stripOuterQuotes(carat[1].trim()) };
	return { prefix: false, label: s };
}

function parseSelector(raw) {
	const s = String(raw).trim();
	if (!s) return null;
	// Don't strip outer quotes up front: for composite forms like "Share" + "_"
	// that would consume the quotes around the *whole* expression and mangle the
	// label. Each sub-part has its quotes stripped where it's extracted instead.
	if (s === '_' || s === '"_"') return { kind: 'sep' };

	let m = s.match(/^"?_"?:\s*has\(\s*\+\s*(.+?)\s*\)$/);
	if (m) {
		const inner = parseLabelOnly(m[1]);
		return inner && { kind: 'sep-before', ...inner };
	}

	m = s.match(/^(.+?)\s*\+\s*"?_"?$/);
	if (m) {
		const inner = parseLabelOnly(m[1]);
		return inner && { kind: 'sep-after', ...inner };
	}

	const inner = parseLabelOnly(s);
	return inner && { kind: 'self', ...inner };
}

function parseSelectors(raw) {
	const list = Array.isArray(raw) ? raw : [];
	return list.filter(s => typeof s === 'string').map(parseSelector).filter(Boolean);
}

function cssEscape(s) {
	return s.replace(/[\\"]/g, '\\$&');
}

// VSCode aria-labels use the "…" ellipsis; users typically type "...". Emit
// whichever form is missing so either is accepted in the config.
function labelVariants(label) {
	const set = new Set([label]);
	if (label.includes('...')) set.add(label.replace(/\.\.\./g, '…'));
	if (label.includes('…')) set.add(label.replace(/…/g, '...'));
	return [...set];
}

// Build the stylesheet that hides labelled items before VSCode measures the
// menu. Only `self` selectors map to CSS — separator selectors are handled in
// the JS runtime, because a separator's `separator` class is applied after the
// element is created, so a CSS rule wouldn't reliably catch it before VSCode
// measures the menu (item aria-labels, by contrast, are present at creation).
function selectorsToCss(parsed) {
	const rules = parsed
		.filter(sel => sel.kind === 'self' && sel.label)
		.flatMap(sel => labelVariants(sel.label).map(v =>
			`.action-item:has(.action-label[aria-label${sel.prefix ? '^=' : '='}"${cssEscape(v)}"])`));
	return rules.length ? `${rules.join(',\n')} { display: none !important; }` : '';
}

module.exports = { parseSelector, parseSelectors, selectorsToCss };
