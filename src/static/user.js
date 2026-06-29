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

	// #### Item hiding via CSS ###################################################
	// Labelled items are hidden with a stylesheet injected into each menu's shadow
	// root (and the document), so the rule is in place *before* VSCode builds and
	// measures the menu. VSCode then sizes and positions the already-shrunk menu
	// itself — which is why this file no longer needs to clamp a stranded
	// scrollbar or re-anchor the menu to the cursor. Separator trimming below
	// stays in JS: whether a separator is leading/trailing/adjacent depends on the
	// runtime visibility of its neighbours, which CSS can't compute reliably.

	function cssEscape(s) {
		return s.replace(/[\\"]/g, '\\$&');
	}

	// VSCode aria-labels use the "…" ellipsis; users typically type "...". Match
	// whichever form is missing so either works in the config.
	function labelVariants(label) {
		const set = new Set([label]);
		if (label.includes('...')) set.add(label.replace(/\.\.\./g, '…'));
		if (label.includes('…')) set.add(label.replace(/…/g, '...'));
		return [...set];
	}

	function selfSelectorToCss(sel) {
		if (sel.kind !== 'self' || !sel.label) return null;
		const op = sel.prefix ? '^=' : '=';
		return labelVariants(sel.label)
			.map(v => `.action-item:has(.action-label[aria-label${op}"${cssEscape(v)}"])`)
			.join(', ');
	}

	const cssSelectors = SELECTORS.map(selfSelectorToCss).filter(Boolean).join(',\n');
	const cssText = cssSelectors ? `${cssSelectors} { display: none !important; }` : '';
	let sheet = null;
	if (cssText) {
		try { sheet = new CSSStyleSheet(); sheet.replaceSync(cssText); } catch (e) { sheet = null; }
	}

	function injectSheet(root) {
		if (!cssText) return;
		try {
			if (sheet && root.adoptedStyleSheets) {
				if (!root.adoptedStyleSheets.includes(sheet)) {
					root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
				}
				return;
			}
		} catch (e) { /* fall through to a <style> node */ }
		try {
			const styleEl = document.createElement('style');
			styleEl.textContent = cssText;
			(root.head || root).appendChild(styleEl);
		} catch (e) { /* ignore */ }
	}

	// #### Separator trimming via JS ############################################

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

	function trimSeparators(container) {
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
				if (sel.kind === 'sep' && seps[i]) hide[i] = true;
				else if (sel.kind === 'sep-after' && seps[i] && i > 0 && !seps[i-1] && labelMatches(sel, labels[i-1])) hide[i] = true;
				else if (sel.kind === 'sep-before' && seps[i] && i < items.length-1 && !seps[i+1] && labelMatches(sel, labels[i+1])) hide[i] = true;
			}
		}

		// "visible after our pass" = not in hide[] AND not already hidden by some
		// other rule (our own CSS, extension CSS, when-clauses, etc.). Using
		// computed style here lets trim/collapse see across the items the CSS
		// hid, so a separator next to a hidden command still gets trimmed.
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

		// Only touch separators here — labelled items are owned by the CSS above.
		for (let i = 0; i < items.length; i++) {
			if (!seps[i]) continue;
			if (hide[i]) items[i].style.setProperty('display', 'none', 'important');
			else items[i].style.removeProperty('display');
		}
	}

	// #### Wiring ###############################################################

	const MENU_SELECTOR = '.monaco-menu-container';

	function attachMenu(node) {
		trimSeparators(node);
		if (!node.__ccmObs) {
			const o = new MutationObserver(() => trimSeparators(node));
			o.observe(node, { childList: true, subtree: true });
			node.__ccmObs = o;
		}
	}

	function processNode(node) {
		if (node.nodeType !== 1) return;
		if (node.matches?.(MENU_SELECTOR)) attachMenu(node);
		for (const m of node.querySelectorAll?.(MENU_SELECTOR) || []) attachMenu(m);
	}

	function watch(root) {
		new MutationObserver((mutations) => {
			for (const mut of mutations) {
				for (const node of mut.addedNodes) processNode(node);
			}
		}).observe(root, { childList: true, subtree: true });
	}

	// Menus render inside shadow roots; inject the stylesheet as each is created
	// (before VSCode populates the menu) and watch it for separator trimming.
	const origAttachShadow = Element.prototype.attachShadow;
	Element.prototype.attachShadow = function () {
		const shadow = origAttachShadow.apply(this, arguments);
		try { injectSheet(shadow); watch(shadow); } catch (e) { /* ignore */ }
		return shadow;
	};

	injectSheet(document);
	watch(document);
})();
