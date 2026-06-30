(function () {
	// Injected by the extension: SELECTORS is the pre-parsed structured list
	// ({ kind, prefix, label }), CSS is the generated stylesheet that hides
	// labelled items. The selector grammar and CSS generation live in the
	// extension's selectors.js — this runtime only consumes their output.
	const SELECTORS = %selectors%;
	const CSS = %css%;

	// #### Item hiding via CSS ###################################################
	// The stylesheet is injected into each menu's shadow root (and the document)
	// so the rule is in place *before* VSCode builds and measures the menu. VSCode
	// then sizes, scrolls and positions the already-shrunk menu itself — which is
	// why this runtime no longer clamps a stranded scrollbar or re-anchors the
	// menu. Separator trimming below stays in JS: whether a separator is
	// leading/trailing/adjacent depends on the runtime visibility of its
	// neighbours, which CSS can't compute reliably.

	let sheet = null;
	if (CSS) {
		try { sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); } catch (e) { sheet = null; }
	}

	function injectSheet(root) {
		if (!CSS) return;
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
			styleEl.textContent = CSS;
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
