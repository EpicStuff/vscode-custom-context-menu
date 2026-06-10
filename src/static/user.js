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
			|| !!item.querySelector('.action-label.separator, .codicon.separator');
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

		// "visible after our pass" = not in hide[] AND not already hidden by some
		// other rule (extension CSS, when-clauses, etc.). Using computed style
		// here lets trim/collapse see across externally-hidden items so a sep
		// next to a when-hidden command still gets trimmed.
		const isVisible = (i) => {
			if (hide[i]) return false;
			const style = getComputedStyle(items[i]);
			return style.display !== 'none' && style.visibility !== 'hidden';
		};

		// Trim leading separators and collapse adjacent ones in one forward pass.
		let leadingDone = false;
		let lastVisibleWasSep = false;
		for (let i = 0; i < items.length; i++) {
			if (!isVisible(i)) continue;
			if (seps[i]) {
				if (!leadingDone || lastVisibleWasSep) hide[i] = true;
				else lastVisibleWasSep = true;
			} else {
				leadingDone = true;
				lastVisibleWasSep = false;
			}
		}
		// Trim trailing separators.
		for (let i = items.length - 1; i >= 0; i--) {
			if (!isVisible(i)) continue;
			if (seps[i]) hide[i] = true;
			else break;
		}

		for (let i = 0; i < items.length; i++) {
			if (hide[i]) items[i].style.setProperty('display', 'none', 'important');
			else items[i].style.removeProperty('display');
		}
	}

	const MENU_SELECTOR = '.monaco-menu-container';

	// VSCode measures the menu height before our hides run, so a tall menu
	// near the bottom of the screen gets clamped to viewport top. After we
	// shrink it, the menu is left stranded far from the cursor. We capture
	// the cursor coords on contextmenu, then re-anchor the freshly-shrunk
	// menu next to the cursor (clamping to viewport).
	let pendingAnchor = null;
	document.addEventListener('contextmenu', (e) => {
		pendingAnchor = { x: e.clientX, y: e.clientY, t: Date.now() };
	}, true);
	function takeAnchor() {
		if (!pendingAnchor) return null;
		if (Date.now() - pendingAnchor.t > 250) { pendingAnchor = null; return null; }
		const a = pendingAnchor;
		pendingAnchor = null;
		return a;
	}

	function repositionMenu(container, anchor) {
		if (!anchor) return;
		const rect = container.getBoundingClientRect();
		if (!rect.height || !rect.width) return;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		let left = anchor.x;
		let top = anchor.y;
		if (left + rect.width > vw) left = Math.max(0, anchor.x - rect.width);
		if (top + rect.height > vh) top = Math.max(0, anchor.y - rect.height);
		container.style.setProperty('left', left + 'px', 'important');
		container.style.setProperty('top', top + 'px', 'important');
	}

	function processNode(node) {
		if (node.nodeType !== 1) return;
		if (node.matches?.(MENU_SELECTOR)) {
			const isNew = !node.__ccmObs;
			const anchor = isNew ? takeAnchor() : null;
			applyHide(node);
			if (isNew) repositionMenu(node, anchor);
			if (!node.__ccmObs) {
				const o = new MutationObserver(() => applyHide(node));
				o.observe(node, { childList: true, subtree: true });
				node.__ccmObs = o;
			}
		}
		for (const m of node.querySelectorAll?.(MENU_SELECTOR) || []) {
			const isNew = !m.__ccmObs;
			const anchor = isNew ? takeAnchor() : null;
			applyHide(m);
			if (isNew) repositionMenu(m, anchor);
			if (!m.__ccmObs) {
				const o = new MutationObserver(() => applyHide(m));
				o.observe(m, { childList: true, subtree: true });
				m.__ccmObs = o;
			}
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
