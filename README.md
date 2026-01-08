<div align="center">
    <br />
    <img src="./images/logo.png" alt="InputShare Logo" width="160" height="160" />
    <h1>Custom Context Menu</h1>
</div>

Remove any items from VSCode's context menu (right click menu)

## Screenshots

| Before | After |
| --- | --- |
| ![Context Menu Before](./screenshots/before.png) | ![Context Menu After](./screenshots/after.png) |

## Usage

&emsp;1\. install this extension in VSCode  
&emsp;1.5. optionaly, manually set `custom-contextmenu.workbenchPath` by locating your VS Code installation (e.g., right-click the VS Code shortcut and choose "Open file location"), searching for `workbench.html`/`workbench.esm.html`, then right-clicking the file and choosing "Copy as path"; set that path and re-run `Enable Custom Context Menu`  
&emsp;2. configure `custom-contextmenu.selectors`, see [Selectors configuration](#selectors-configuration)  
&emsp;3. open Command Pallete with `F1` or `ctrl+shift+p`  
&emsp;4. select `Enable Custom Context Menu`  

### Selectors configuration

Set `custom-contextmenu.selectors` in your VS Code settings to hide context menu items by their label. Example:

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

### Grouping configuration

Define `custom-contextmenu.groups` to insert labeled headers and regroup related items. Each group has a label and the same selector patterns used for hiding items. Groups are applied in order; matched items are moved under the group's label.

```json
"custom-contextmenu.groups": [
  {
    "label": "Navigation",
    "selectors": ["^Go to", "Find All References"]
  },
  {
    "label": "Clipboard",
    "selectors": ["Cut", "Copy", "Paste"]
  }
]
```

> Note: after changing `custom-contextmenu.groups`, re-enable the custom context menu or restart VS Code so the injected script is updated.

## Note:

All changes were made by ChatGPT (and I've got no idea how to make vscode extensions or do javascript, but this extension does seem to be working).
