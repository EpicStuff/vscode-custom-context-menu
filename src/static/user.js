(function () {
	const RAW_SELECTORS = %selectors%;

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
		let s = String(raw).trim();
		if (!s) return null;
		s = stripOuterQuotes(s);
		if (s === '_') return { kind: 'sep' };

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

	const SELECTORS = RAW_SELECTORS.map(parseSelector).filter(Boolean);

	function isSeparator(item) {
		return item.classList.contains('separator')
			|| item.getAttribute('role') === 'separator'
			|| !!item.querySelector('.codicon.separator');
	}

	function labelOf(item) {
		const el = item.querySelector('.action-label');
		const raw = (el && (el.getAttribute('aria-label') || el.textContent)) || '';
		return raw.replaceAll('…', '...').replaceAll(/\s+/g, ' ').trim();
	}

	function labelMatches(sel, label) {
		return sel.prefix ? label.startsWith(sel.label) : label === sel.label;
	}

	function applyHide(container) {
		if (container.matches('.titlebar-container *')) return;
		// Include standalone separators alongside action-items so the trim and
		// adjacent-collapse passes can reach them — newer VSCode menus (and some
		// extension contributions) emit separators as plain .separator or
		// [role="separator"] elements rather than .action-item children. Filter
		// out matches that are nested inside other matches (e.g. a .separator
		// codicon inside an .action-item) to avoid double-counting.
		const matches = Array.from(container.querySelectorAll('.action-item, .separator, [role="separator"]'));
		const items = matches.filter(el => !matches.some(other => other !== el && other.contains(el)));
		if (items.length === 0) return;

		const labels = items.map(labelOf);
		const seps = items.map(isSeparator);

		const hide = new Array(items.length).fill(false);
		for (let i = 0; i < items.length; i++) {
			for (const sel of SELECTORS) {
				if (sel.kind === 'self' && !seps[i] && labelMatches(sel, labels[i])) hide[i] = true;
				else if (sel.kind === 'sep' && seps[i]) hide[i] = true;
				else if (sel.kind === 'sep-after' && seps[i] && i > 0 && !seps[i-1] && labelMatches(sel, labels[i-1])) hide[i] = true;
				else if (sel.kind === 'sep-before' && seps[i] && i < items.length-1 && !seps[i+1] && labelMatches(sel, labels[i+1])) hide[i] = true;
			}
		}

		let leadingDone = false;
		let lastVisibleWasSep = false;
		for (let i = 0; i < items.length; i++) {
			if (hide[i]) continue;
			if (seps[i]) {
				if (!leadingDone || lastVisibleWasSep) hide[i] = true;
				else lastVisibleWasSep = true;
			} else {
				leadingDone = true;
				lastVisibleWasSep = false;
			}
		}
		for (let i = items.length - 1; i >= 0; i--) {
			if (hide[i]) continue;
			if (seps[i]) hide[i] = true;
			else break;
		}

		for (let i = 0; i < items.length; i++) {
			if (hide[i]) items[i].style.setProperty('display', 'none', 'important');
			else items[i].style.removeProperty('display');
		}
	}

	const MENU_SELECTOR = '.monaco-menu-container';

	function processNode(node) {
		if (node.nodeType !== 1) return;
		if (node.matches?.(MENU_SELECTOR)) {
			applyHide(node);
			if (!node.__ccmObs) {
				const o = new MutationObserver(() => applyHide(node));
				o.observe(node, { childList: true, subtree: true });
				node.__ccmObs = o;
			}
		}
		for (const m of node.querySelectorAll?.(MENU_SELECTOR) || []) {
			applyHide(m);
		}
	}

	function watch(root) {
		new MutationObserver((mutations) => {
			for (const mut of mutations) {
				for (const node of mut.addedNodes) processNode(node);
			}
		}).observe(root, { childList: true, subtree: true });
	}

	const origAttachShadow = Element.prototype.attachShadow;
	Element.prototype.attachShadow = function () {
		const shadow = origAttachShadow.apply(this, arguments);
		try { watch(shadow); } catch (e) { /* ignore */ }
		return shadow;
	};

	watch(document);
})();
