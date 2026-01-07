<div align="center">
    <br />
    <img src="./images/logo.png" alt="InputShare Logo" width="160" height="160" />
    <h1>Custom Contextmenu</h1>
</div>

Make the contextmenu of VSCode cleaner!

## Screenshots

| Before | After |
| --- | --- |
| ![Contextmenu Before](./screenshots/before.png) | ![Contextmenu After](./screenshots/after.png) |

## Usage

1. install this extension in VSCode
2. open Command Pallete with `F1` or `ctrl+shift+p`
3. select `Enable Custom Contextmenu`

### Selectors configuration

Set `custom-contextmenu.selectors` in your VS Code settings to hide context menu items by their aria-label. Each entry is a selector pattern that the extension converts into an attribute selector before filtering the menu items. The extension will add quotes for you, including separator patterns and `^`-prefixed starts-with matches.

```json
"custom-contextmenu.selectors": [
  "^Go to",
  "Cut",
  "Copy",
  "Paste",
  "_:has( + ^Find All)"
]
```

- Plain labels match exact labels (e.g., `"Copy"`).
- Prefix with `^` to match items that start with a label (e.g., `"^Go to"`).
- Separators are represented by the placeholder label `"_"`. Use `_:has( + ...)` to hide the separator that appears before the matched item, and use the `... + _` pattern to hide the separator after the matched item.

Separator examples:

```json
"custom-contextmenu.selectors": [
  "_:has( + Share)",
  "Share + _"
]
```

The first entry hides the separator immediately before the `Share` menu item (when present). The second entry hides the separator immediately after the `Share` menu item (when present). If you prefer the fully-quoted syntax, it still works (e.g., `"\"Share\" + \"_\""`).

> Note: `Paste + _` (or `Share + _`) only hides the separator after the item. To hide the menu item itself, add the item label separately (for example, include `"Paste"`).

> Note: after changing `custom-contextmenu.selectors`, re-enable the custom context menu or restart VS Code so the injected script is updated.
