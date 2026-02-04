/**
 * modified from:
 * author: https://github.com/Long0x0
 * source: https://github.com/microsoft/vscode/issues/75930#issuecomment-2310690013
 */

(function() {
  console.log("Hello from custom_context_menu.js~");
  const selectors = %selectors%;

  const css_selectors = selectors
    .join(",\n")
    .replaceAll(/([*^|])?"(.+?)"/g, '[aria-label\x241="\x242"]');

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
  let last_mouse_time = 0;
  document.addEventListener("mouseup", (e) => {
    // bug: not working in titlebar
    if (e.button === 2) {
      mouse_y = e.clientY;
      last_mouse_time = Date.now();
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
      `.replaceAll(/\s+/g, " ");
    requestAnimationFrame(() => {
      hideTrailingSeparator(container);
    });
    if (!container.__customContextMenuObserver) {
      const separatorObserver = new MutationObserver(() => {
        if (container.__customContextMenuRaf) {
          return;
        }
        container.__customContextMenuRaf = requestAnimationFrame(() => {
          container.__customContextMenuRaf = null;
          hideTrailingSeparator(container);
        });
      });
      separatorObserver.observe(container, {
        childList: true,
        subtree: true,
      });
      container.__customContextMenuObserver = separatorObserver;
    }

    // fix context menu position
    if (menu.matches(".monaco-submenu")) {
      return;
    }
    const is_recent_right_click = Date.now() - last_mouse_time < 1000;
    if (!is_recent_right_click) {
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
    const getSeparatorElement = item => {
      const separator = item.querySelector(":scope > .action-label.separator");
      if (separator && separator.closest(".action-item") === item) {
        return separator;
      }
      return null;
    };
    const getVisibilityTarget = item => {
      const separator = getSeparatorElement(item);
      if (separator) {
        return separator;
      }
      const label = item.querySelector(".action-label, .action-menu-item");
      return label || item;
    };
    const isSeparator = item =>
      getSeparatorElement(item) ||
      item.classList.contains("separator") ||
      item.getAttribute("role") === "separator" ||
      item.querySelector(".codicon.separator");
    const isRendered = item => {
      const target = getVisibilityTarget(item);
      const itemStyle = getComputedStyle(item);
      const targetStyle = getComputedStyle(target);
      const hasRects =
        target.getClientRects().length > 0 ||
        item.getClientRects().length > 0 ||
        target.offsetWidth > 0 ||
        target.offsetHeight > 0 ||
        item.offsetWidth > 0 ||
        item.offsetHeight > 0;
      const hasSeparatorBorder =
        isSeparator(item) &&
        (parseFloat(targetStyle.borderTopWidth) > 0 ||
          parseFloat(targetStyle.borderBottomWidth) > 0);
      return (
        itemStyle.display !== "none" &&
        itemStyle.visibility !== "hidden" &&
        targetStyle.display !== "none" &&
        targetStyle.visibility !== "hidden" &&
        (hasRects || hasSeparatorBorder)
      );
    };
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
})();
