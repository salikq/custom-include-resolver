# custom-include-resolver

VSCode extension for resolving in-house include/resource paths in text files.

Supports:

- `F12` (`Go to Definition`) for custom include strings
- `Ctrl+Click` navigation (via definition provider)
- `CompletionItemProvider` (autocomplete paths after full module prefix is typed)
- `DocumentLinkProvider` (clickable include paths)
- Optional diagnostics (`Problems`) for unresolved includes
- Multi-root workspace
- Incremental per-module file index updates via `FileSystemWatcher`

---

## Why

Many in-house game engines use custom resource paths, e.g.:

- `render:shaders/pbr.hlsl`
- `/render/shaders/pbr.hlsl`

This extension maps logical module names to real filesystem roots and resolves includes/navigation in editor.

---

## Activation

Extension activates only when workspace folder contains:

- `.custom-include-workspace.json`

For multi-root workspaces, each root can have its own config.

---

## Configuration file

Create `.custom-include-workspace.json` in each workspace folder root.

### Schema

```json
{
  "prefix": "$MODULE:",
  "languages": ["cpp", "glsl", "yaml"],
  "extensions": [".hlsl", ".hlsli", ".glsl", ".yaml"],
  "diagnostics": true,
  "modules": {
    "render": "./modules/render_sce/res/render",
    "devui": "./modules/devui/res/devui"
  }
}
```

### Fields

- `prefix` (string, required)
  - Template with **exactly one** `$MODULE`.
  - Examples:
    - `"$MODULE:"` for `module:path/to/file`
    - `"/$MODULE/"` for `/module/path/to/file`
- `modules` (object, required)
  - Module name -> relative path to real module root on filesystem.
- `languages` (string[], optional)
  - Allowed VSCode language IDs for parsing documents.
- `extensions` (string[], optional)
  - Allowed source file extensions for parsing documents.
- `diagnostics` (boolean, optional, default `false`)
  - Show unresolved include/module warnings in `Problems`.
- `documentLinks` (boolean, optional, default `true`)
  - Enable/disable `DocumentLinkProvider` for include tokens.

---

## Supported include token delimiters

Only these forms are parsed:

- `"..."`
- `'...'`
- `<...>`

Examples:

- `"render:shaders/pbr.hlsl"`
- `<render:shaders/pbr.hlsl>`
- `'/render/shaders/pbr.hlsl'`

Escape sequences inside strings are intentionally not supported in current version.

---

## Behavior details

### Go to Definition (`F12`)

- Works when cursor is inside include token.
- If multiple targets are found, extension shows `Quick Pick`.

### Autocomplete

- Starts **only after full concrete module prefix is typed**.
- Example with `prefix = "$MODULE:"`:
  - no completion for `ren`
  - completion starts after `render:`
- Example with `prefix = "/$MODULE/"`:
  - completion starts after `/render/`

### Document links

- Resolved include tokens become clickable links.

### Diagnostics (optional)

When `"diagnostics": true`:

- Warning for unknown module
- Warning for unresolved include path

---

## Incremental index

Extension builds file index per module and keeps it up-to-date incrementally:

- file create -> add to index
- file delete -> remove from index
- file change -> validated as file and synchronized

Also available command:

- `Custom Include Resolver: Rebuild File Index`

---

## Commands

- `Custom Include Resolver: Reload Workspace Configs`
- `Custom Include Resolver: Rebuild File Index`

Open Command Palette and run by name.

---

## Development

### Run

```bash
npm install
npm run compile
```

Press `F5` in VSCode to launch Extension Development Host.

### Package

```bash
npx @vscode/vsce package
```

Install via `Extensions: Install from VSIX...`.

---

## Known limitations

- No escape-sequence parsing in include strings.
- No symlink-specific handling.
- Path normalization is minimal by design.
- No include parsing outside configured `languages`/`extensions`.
