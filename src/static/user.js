/**
 * modified from:
 * author: https://github.com/Long0x0
 * source: https://github.com/microsoft/vscode/issues/75930#issuecomment-2310690013
 */

(function() {
  console.log("Hello from custom_context_menu.js~");
  const selectors = %selectors%;
  const groups = %groups%;

  const css_selectors = buildCssSelectors(selectors);

  function buildCssSelectors(list) {
    return list
      .join(",\n")
      .replaceAll(/([*^|])?"(.+?)"/g, '[aria-label\x241="\x242"]');
  }

  function buildCssSelectorList(list) {
    if (!Array.isArray(list)) {
      return [];
    }
    const css = buildCssSelectors(list);
    if (!css.trim()) {
      return [];
    }
    return css.split(",").map((entry) => entry.trim()).filter(Boolean);
  }

  function wait_for(root) {
    const selector = ".monaco-menu-container > .monaco-scrollable-element";
    new MutationObserver((mutations) => {
      for (let mutation of mutations) {
        for (let node of mutation.addedNodes) {
          if (node.matches?.(selector)) {
            // console.log(">>", node);
            modify(node);
          }
        }
      }
    }).observe(root, { subtree: true, childList: true });
  }

  // context menu in editor
  Element.prototype._attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function () {
    const shadow = this._attachShadow({ mode: "open" });
    wait_for(shadow);
    return shadow;
  };
  // context menu in other places
  wait_for(document);

  // get mouse position
  let mouse_y = 0;
  document.addEventListener("mouseup", (e) => {
    // bug: not working in titlebar
    if (e.button === 2) {
      mouse_y = e.clientY;
    }
  });

  function modify(container) {
    if (container.matches('.titlebar-container *')) {
      // skip titlebar
      return;
    }
    for (let item of container.querySelectorAll(".action-item")) {
      const label = item.querySelector(".action-label");
      const aria_label = label?.getAttribute("aria-label") || "_";
      item.setAttribute("aria-label", aria_label);
    }

    const menu = container.parentNode;
    const style = document.createElement("style");
    menu.appendChild(style);
    style.innerText = `
      :host > .monaco-menu-container, :not(.menubar-menu-button) > .monaco-menu-container {
        ${css_selectors},
        .visible.scrollbar.vertical, .shadow {
          display: none !important;
        }
      }
      .custom-contextmenu-group .action-label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.6;
        pointer-events: none;
      }
      `.replaceAll(/\s+/g, " ");
    applyGrouping(container);
    requestAnimationFrame(() => {
      hideTrailingSeparator(container);
    });

    // fix context menu position
    if (menu.matches(".monaco-submenu")) {
      return;
    }
    let menu_top = parseInt(menu.style.top);
    const menu_height = menu.clientHeight;
    // console.log("menu_top", menu_top, "menu_height", menu_height);
    const titlebar_height = 40;
    const window_height = window.innerHeight;
    if (menu_top < titlebar_height && menu_height < 90) {
      mouse_y = menu_top;
    } else {
      if (mouse_y < window_height / 2) {
        menu_top = mouse_y;
        if (menu_top + menu_height > window_height) {
          menu_top = window_height - menu_height;
        }
      } else {
        menu_top = mouse_y - menu_height;
        if (menu_top < titlebar_height) {
          menu_top = titlebar_height;
        }
      }
      menu.style.top = menu_top + "px";
    }
  }

  function hideTrailingSeparator(container) {
    const items = Array.from(container.querySelectorAll(".action-item"));
    const isRendered = item => {
      const label = item.querySelector(".action-label, .action-menu-item");
      const target = label || item;
      const itemStyle = getComputedStyle(item);
      const targetStyle = getComputedStyle(target);
      return (
        itemStyle.display !== "none" &&
        itemStyle.visibility !== "hidden" &&
        targetStyle.display !== "none" &&
        targetStyle.visibility !== "hidden" &&
        target.getClientRects().length > 0
      );
    };
    const isSeparator = item =>
      item.classList.contains("separator") ||
      item.getAttribute("role") === "separator" ||
      item.querySelector(".codicon.separator");
    for (const item of items) {
      if (item.dataset.autoHideSeparator === "true") {
        item.style.removeProperty("display");
        delete item.dataset.autoHideSeparator;
      }
    }
    const visibleItems = items.filter(isRendered);
    const firstItem = visibleItems.at(0);
    if (firstItem && isSeparator(firstItem)) {
      firstItem.dataset.autoHideSeparator = "true";
      firstItem.style.display = "none";
    }
    const lastItem = visibleItems.at(-1);
    if (lastItem && isSeparator(lastItem)) {
      lastItem.dataset.autoHideSeparator = "true";
      lastItem.style.display = "none";
    }
  }

  function applyGrouping(container) {
    if (!Array.isArray(groups) || groups.length === 0) {
      return;
    }
    const actionsContainer =
      container.querySelector(".actions-container") ||
      container.querySelector(".actions") ||
      container.querySelector(".monaco-action-bar") ||
      container;
    actionsContainer
      .querySelectorAll(".custom-contextmenu-group")
      .forEach((item) => item.remove());
    const items = Array.from(
      actionsContainer.querySelectorAll(".action-item")
    ).filter((item) => !item.classList.contains("custom-contextmenu-group"));
    const isSeparator = item =>
      item.classList.contains("separator") ||
      item.getAttribute("role") === "separator" ||
      item.querySelector(".codicon.separator");
    const used = new Set();
    for (const group of groups) {
      if (!group || typeof group.label !== "string") {
        continue;
      }
      const selectorList = buildCssSelectorList(group.selectors || []);
      if (selectorList.length === 0) {
        continue;
      }
      const matchesSelectors = (item) =>
        selectorList.some((selector) => item.matches(selector));
      const groupItems = items.filter(
        (item) =>
          !used.has(item) &&
          !isSeparator(item) &&
          matchesSelectors(item)
      );
      if (groupItems.length === 0) {
        continue;
      }
      const parentNode = groupItems[0].parentNode;
      if (!parentNode) {
        continue;
      }
      const header = createGroupHeader(group.label);
      if (parentNode.contains(groupItems[0])) {
        parentNode.insertBefore(header, groupItems[0]);
      } else {
        parentNode.appendChild(header);
      }
      let insertPoint = header;
      for (const item of groupItems) {
        const targetParent = item.parentNode || parentNode;
        if (targetParent !== parentNode) {
          continue;
        }
        if (item === insertPoint.nextSibling) {
          insertPoint = item;
        } else if (insertPoint.parentNode === parentNode) {
          parentNode.insertBefore(item, insertPoint.nextSibling);
          insertPoint = item;
        } else {
          parentNode.appendChild(item);
          insertPoint = item;
        }
        used.add(item);
      }
    }
  }

  function createGroupHeader(label) {
    const header = document.createElement("li");
    header.className = "action-item custom-contextmenu-group";
    header.setAttribute("role", "presentation");
    const text = document.createElement("span");
    text.className = "action-label";
    text.setAttribute("aria-label", label);
    text.textContent = label;
    header.appendChild(text);
    return header;
  }
})();
