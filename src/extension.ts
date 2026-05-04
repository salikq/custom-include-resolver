import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const CONFIG_FILE_NAME = '.custom-include-workspace.json';

interface WorkspaceResolverConfig {
  /**
   * Prefix template with exactly one $MODULE.
   * Examples:
   * - "$MODULE:"
   * - "/$MODULE/"
   */
  prefix: string;
  modules: Record<string, string>; // module -> relative path from workspace root
  extensions: string[]; // parsed source file extensions (perf filter), e.g. [".hlsl", ".yaml"]
  languages: string[]; // parsed source language ids, e.g. ["cpp", "glsl"]
  diagnostics?: boolean; // optional diagnostics in Problems
  documentLinks?: boolean; // enable document links
}

interface WorkspaceState {
  folder: vscode.WorkspaceFolder;
  config: WorkspaceResolverConfig;

  moduleAbsPaths: Map<string, string>; // module -> absolute path
  moduleConcretePrefixes: Map<string, string>; // module -> prefix with $MODULE substituted
  modulesByConcretePrefixLengthDesc: string[];

  prefixParseRegex: RegExp; // generic parse: prefix + path remainder
  fileIndexByModule: Map<string, Set<string>>; // module -> relative file paths ("/" separated)

  moduleWatchDisposables: vscode.Disposable[];
}

interface ClosedToken {
  value: string;
  contentStart: number;
  contentEndExclusive: number;
}

interface TokenContext {
  value: string;
  valueBeforeCursor: string;
  contentStart: number;
  contentEndExclusive: number;
}

const states = new Map<string, WorkspaceState>();

let output: vscode.OutputChannel;
let diagnostics: vscode.DiagnosticCollection;
const diagTimers = new Map<string, ReturnType<typeof setTimeout>>();
const folderDiagRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('custom-include-resolver');
  diagnostics = vscode.languages.createDiagnosticCollection('custom-include-resolver');

  context.subscriptions.push(output, diagnostics);

  log('Activating custom-include-resolver...');
  await reloadAllWorkspaceConfigs();
  await refreshDiagnosticsForOpenDocuments();

  const selector: vscode.DocumentSelector = [{ scheme: 'file' }];

  const definitionProvider = vscode.languages.registerDefinitionProvider(selector, {
    provideDefinition: async (document, position) => {
      try {
        return await provideDefinition(document, position);
      } catch (err) {
        log(`Unexpected error in provideDefinition: ${String(err)}`);
        return null;
      }
    }
  });

  const completionProvider = vscode.languages.registerCompletionItemProvider(
    selector,
    {
      provideCompletionItems: async (document, position) => {
        try {
          return await provideCompletionItems(document, position);
        } catch (err) {
          log(`Unexpected error in provideCompletionItems: ${String(err)}`);
          return null;
        }
      }
    },
    ':',
    '/',
    '\\'
  );

  const documentLinkProvider = vscode.languages.registerDocumentLinkProvider(selector, {
    provideDocumentLinks: async (document) => {
      try {
        return await provideDocumentLinks(document);
      } catch (err) {
        log(`Unexpected error in provideDocumentLinks: ${String(err)}`);
        return [];
      }
    }
  });

  const configWatcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE_NAME}`);

  context.subscriptions.push(
    definitionProvider,
    completionProvider,
    documentLinkProvider,
    configWatcher,

    vscode.commands.registerCommand('customIncludeResolver.reloadWorkspaceConfigs', async () => {
      await reloadAllWorkspaceConfigs();
      await refreshDiagnosticsForOpenDocuments();
      vscode.window.showInformationMessage('custom-include-resolver: configs reloaded.');
    }),

    vscode.commands.registerCommand('customIncludeResolver.rebuildFileIndex', async () => {
      await rebuildAllFileIndexes();
      await refreshDiagnosticsForOpenDocuments();
      vscode.window.showInformationMessage('custom-include-resolver: file index rebuilt.');
    }),

    configWatcher.onDidCreate(async (uri) => {
      await reloadConfigForUri(uri);
      await refreshDiagnosticsForOpenDocuments();
    }),
    configWatcher.onDidChange(async (uri) => {
      await reloadConfigForUri(uri);
      await refreshDiagnosticsForOpenDocuments();
    }),
    configWatcher.onDidDelete(async (uri) => {
      await reloadConfigForUri(uri);
      await refreshDiagnosticsForOpenDocuments();
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await reloadAllWorkspaceConfigs();
      await refreshDiagnosticsForOpenDocuments();
    }),

    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (path.basename(doc.fileName) === CONFIG_FILE_NAME) {
        const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
        if (folder) {
          await loadConfigForFolder(folder);
          await refreshDiagnosticsForOpenDocuments();
        }
      } else {
        scheduleDiagnosticsUpdate(doc);
      }
    }),

    vscode.workspace.onDidOpenTextDocument((doc) => {
      scheduleDiagnosticsUpdate(doc);
    }),

    vscode.workspace.onDidChangeTextDocument((e) => {
      scheduleDiagnosticsUpdate(e.document);
    }),

    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnostics.delete(doc.uri);
      const key = doc.uri.toString();
      const timer = diagTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        diagTimers.delete(key);
      }
    })
  );

  log('Activated.');
}

export function deactivate(): void {
  disposeAllStates();
}

/* ----------------------------- Providers ----------------------------- */

async function provideDefinition(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<vscode.Definition | null> {
  const state = getStateForDocument(document);
  if (!state || !isDocumentAllowed(document, state.config)) {
    return null;
  }

  const line = document.lineAt(position.line).text;
  const tokens = getClosedTokensFromLine(line);
  const token = tokens.find(
    (t) => position.character >= t.contentStart && position.character <= t.contentEndExclusive
  );
  if (!token) {
    return null;
  }

  const includeRaw = token.value.trim();
  const resolved = await resolveIncludeToExistingFiles(state, includeRaw);
  if (!resolved || resolved.uris.length === 0) {
    return null;
  }

  let target: vscode.Uri;
  if (resolved.uris.length === 1) {
    target = resolved.uris[0];
  } else {
    const picked = await vscode.window.showQuickPick(
      resolved.uris.map((uri) => ({
        label: path.basename(uri.fsPath),
        description: vscode.workspace.asRelativePath(uri, false),
        uri
      })),
      {
        placeHolder: `Multiple matches for "${includeRaw}". Select target file`
      }
    );
    if (!picked) {
      return null;
    }
    target = picked.uri;
  }

  log(`[${state.folder.name}] Resolved "${includeRaw}" -> ${target.fsPath}`);
  return new vscode.Location(target, new vscode.Position(0, 0));
}

async function provideCompletionItems(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<vscode.CompletionItem[] | null> {
  const state = getStateForDocument(document);
  if (!state || !isDocumentAllowed(document, state.config)) {
    return null;
  }

  const line = document.lineAt(position.line).text;
  const ctx = findTokenContextAtOrOpen(line, position.character);
  if (!ctx) {
    return null;
  }

  const prefixMatch = matchTypedPrefixForCompletion(ctx.valueBeforeCursor, state);
  if (!prefixMatch) {
    return null;
  }

  const moduleFiles = state.fileIndexByModule.get(prefixMatch.moduleName) ?? new Set<string>();
  const partialPath = prefixMatch.partialPath.replace(/\\/g, '/');

  const lastSlash = partialPath.lastIndexOf('/');
  const dirPrefix = lastSlash >= 0 ? partialPath.slice(0, lastSlash + 1) : '';
  const namePrefix = lastSlash >= 0 ? partialPath.slice(lastSlash + 1) : partialPath;

  const suggestions = collectPathSuggestions(moduleFiles, dirPrefix, namePrefix);
  if (suggestions.length === 0) {
    return null;
  }

  const replaceStartChar =
    ctx.contentStart + prefixMatch.concretePrefix.length + dirPrefix.length;
  const replaceRange = new vscode.Range(
    new vscode.Position(position.line, replaceStartChar),
    position
  );

  return suggestions.map((s) => {
    const item = new vscode.CompletionItem(
      s.label,
      s.isFolder ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File
    );
    item.insertText = s.insertText;
    item.range = replaceRange;
    item.detail = `${prefixMatch.concretePrefix}${dirPrefix}`;
    return item;
  });
}

async function provideDocumentLinks(
  document: vscode.TextDocument
): Promise<vscode.DocumentLink[]> {
  const state = getStateForDocument(document);
  if (!state || !isDocumentAllowed(document, state.config)) {
    return [];
  }

  if (state.config.documentLinks === false) {
    return [];
  }

  const links: vscode.DocumentLink[] = [];
  for (let lineNum = 0; lineNum < document.lineCount; lineNum++) {
    const line = document.lineAt(lineNum).text;
    const tokens = getClosedTokensFromLine(line);

    for (const token of tokens) {
      const resolved = await resolveIncludeToExistingFiles(state, token.value.trim());
      if (!resolved || resolved.uris.length === 0) {
        continue;
      }

      const target = resolved.uris[0];
      const range = new vscode.Range(
        new vscode.Position(lineNum, token.contentStart),
        new vscode.Position(lineNum, token.contentEndExclusive)
      );

      links.push(new vscode.DocumentLink(range, target));
    }
  }

  return links;
}

/* ----------------------------- Diagnostics ----------------------------- */

function scheduleDiagnosticsUpdate(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  const existing = diagTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(async () => {
    diagTimers.delete(key);
    await updateDiagnosticsForDocument(document);
  }, 300);

  diagTimers.set(key, timer);
}

function scheduleFolderDiagnosticsRefresh(folder: vscode.WorkspaceFolder): void {
  const key = folder.uri.toString();
  const existing = folderDiagRefreshTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(async () => {
    folderDiagRefreshTimers.delete(key);
    await refreshDiagnosticsForFolder(folder);
  }, 350);

  folderDiagRefreshTimers.set(key, timer);
}

async function refreshDiagnosticsForOpenDocuments(): Promise<void> {
  for (const doc of vscode.workspace.textDocuments) {
    await updateDiagnosticsForDocument(doc);
  }
}

async function refreshDiagnosticsForFolder(folder: vscode.WorkspaceFolder): Promise<void> {
  for (const doc of vscode.workspace.textDocuments) {
    const f = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (f && f.uri.toString() === folder.uri.toString()) {
      await updateDiagnosticsForDocument(doc);
    }
  }
}

async function updateDiagnosticsForDocument(document: vscode.TextDocument): Promise<void> {
  const state = getStateForDocument(document);
  if (!state) {
    diagnostics.delete(document.uri);
    return;
  }

  if (!isDocumentAllowed(document, state.config) || !state.config.diagnostics) {
    diagnostics.delete(document.uri);
    return;
  }

  const out: vscode.Diagnostic[] = [];

  for (let lineNum = 0; lineNum < document.lineCount; lineNum++) {
    const line = document.lineAt(lineNum).text;
    const tokens = getClosedTokensFromLine(line);

    for (const token of tokens) {
      const includeRaw = token.value.trim();
      const parsed = parseIncludeByPrefixTemplate(state, includeRaw);
      if (!parsed) {
        continue;
      }

      const moduleBase = state.moduleAbsPaths.get(parsed.moduleName);
      const range = new vscode.Range(
        new vscode.Position(lineNum, token.contentStart),
        new vscode.Position(lineNum, token.contentEndExclusive)
      );

      if (!moduleBase) {
        out.push(
          new vscode.Diagnostic(
            range,
            `Unknown module "${parsed.moduleName}" in include "${includeRaw}"`,
            vscode.DiagnosticSeverity.Warning
          )
        );
        continue;
      }

      const candidates = buildCandidatePaths(moduleBase, parsed.includePath, state.config.extensions);
      const existing = await existingUris(candidates);
      if (existing.length === 0) {
        out.push(
          new vscode.Diagnostic(
            range,
            `Unresolved include "${includeRaw}"`,
            vscode.DiagnosticSeverity.Warning
          )
        );
      }
    }
  }

  diagnostics.set(document.uri, out);
}

/* --------------------------- Resolve / Parse --------------------------- */

function getStateForDocument(document: vscode.TextDocument): WorkspaceState | null {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) {
    return null;
  }
  return states.get(folder.uri.toString()) ?? null;
}

function isDocumentAllowed(doc: vscode.TextDocument, cfg: WorkspaceResolverConfig): boolean {
  if (cfg.languages.length > 0 && !cfg.languages.includes(doc.languageId)) {
    return false;
  }

  if (cfg.extensions.length > 0) {
    const ext = path.extname(doc.fileName);
    if (!cfg.extensions.includes(ext)) {
      return false;
    }
  }

  return true;
}

async function resolveIncludeToExistingFiles(
  state: WorkspaceState,
  includeRaw: string
): Promise<{ moduleName: string; includePath: string; uris: vscode.Uri[] } | null> {
  const parsed = parseIncludeByPrefixTemplate(state, includeRaw);
  if (!parsed) {
    return null;
  }

  const moduleBase = state.moduleAbsPaths.get(parsed.moduleName);
  if (!moduleBase) {
    log(`[${state.folder.name}] Unknown module "${parsed.moduleName}" in include "${includeRaw}"`);
    return null;
  }

  if (!parsed.includePath) {
    return null;
  }

  const candidates = buildCandidatePaths(moduleBase, parsed.includePath, state.config.extensions);
  const uris = await existingUris(candidates);
  return { moduleName: parsed.moduleName, includePath: parsed.includePath, uris };
}

function parseIncludeByPrefixTemplate(
  state: WorkspaceState,
  includeRaw: string
): { moduleName: string; includePath: string } | null {
  const m = state.prefixParseRegex.exec(includeRaw);
  if (!m?.groups) {
    return null;
  }

  const moduleName = m.groups.module ?? '';
  const includePath = m.groups.path ?? '';

  if (!moduleName) {
    return null;
  }

  return { moduleName, includePath };
}

function matchTypedPrefixForCompletion(
  typedTokenBeforeCursor: string,
  state: WorkspaceState
): { moduleName: string; concretePrefix: string; partialPath: string } | null {
  for (const moduleName of state.modulesByConcretePrefixLengthDesc) {
    const concretePrefix = state.moduleConcretePrefixes.get(moduleName);
    if (!concretePrefix) {
      continue;
    }

    // completion starts only after full concrete prefix is typed
    if (typedTokenBeforeCursor.startsWith(concretePrefix)) {
      const partialPath = typedTokenBeforeCursor.slice(concretePrefix.length);
      return { moduleName, concretePrefix, partialPath };
    }
  }

  return null;
}

function buildCandidatePaths(moduleBaseAbs: string, includePath: string, parseExtensions: string[]): string[] {
  if (!includePath) {
    return [];
  }

  const cleanedIncludePath = includePath.replace(/^[/\\]+/, '');
  const set = new Set<string>();

  const direct = path.join(moduleBaseAbs, cleanedIncludePath);
  set.add(direct);

  const hasExt = path.extname(cleanedIncludePath).length > 0;
  if (!hasExt) {
    for (const ext of parseExtensions) {
      set.add(`${direct}${ext}`);
    }
  }

  return [...set];
}

async function existingUris(absPaths: string[]): Promise<vscode.Uri[]> {
  const out: vscode.Uri[] = [];
  for (const p of absPaths) {
    if (await isFile(p)) {
      out.push(vscode.Uri.file(p));
    }
  }
  return out;
}

async function isFile(absPath: string): Promise<boolean> {
  try {
    const s = await fs.stat(absPath);
    return s.isFile();
  } catch {
    return false;
  }
}

/* ------------------------------ Tokenizers ----------------------------- */

function getClosedTokensFromLine(line: string): ClosedToken[] {
  const tokens: ClosedToken[] = [];
  const re = /"([^"\r\n]+)"|'([^'\r\n]+)'|<([^<>\r\n]+)>/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(line)) !== null) {
    const full = m[0];
    const start = m.index;
    const contentStart = start + 1;
    const contentEndExclusive = start + full.length - 1;
    const value = line.slice(contentStart, contentEndExclusive);

    tokens.push({ value, contentStart, contentEndExclusive });
  }

  return tokens;
}

function findTokenContextAtOrOpen(line: string, cursorChar: number): TokenContext | null {
  let openDelim: '"' | "'" | '<' | null = null;
  let openIndex = -1;

  const closeDelimOf = (d: '"' | "'" | '<'): '"' | "'" | '>' => (d === '<' ? '>' : d);

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (!openDelim) {
      if (ch === '"' || ch === "'" || ch === '<') {
        openDelim = ch;
        openIndex = i;
      }
      continue;
    }

    const closeDelim = closeDelimOf(openDelim);
    if (ch === closeDelim) {
      const contentStart = openIndex + 1;
      const contentEndExclusive = i;

      if (cursorChar >= contentStart && cursorChar <= contentEndExclusive) {
        const value = line.slice(contentStart, contentEndExclusive);
        const valueBeforeCursor = line.slice(contentStart, Math.min(cursorChar, contentEndExclusive));
        return { value, valueBeforeCursor, contentStart, contentEndExclusive };
      }

      openDelim = null;
      openIndex = -1;
    }
  }

  if (openDelim && openIndex >= 0) {
    const contentStart = openIndex + 1;
    const contentEndExclusive = line.length;

    if (cursorChar >= contentStart && cursorChar <= contentEndExclusive) {
      const value = line.slice(contentStart, contentEndExclusive);
      const valueBeforeCursor = line.slice(contentStart, Math.min(cursorChar, contentEndExclusive));
      return { value, valueBeforeCursor, contentStart, contentEndExclusive };
    }
  }

  return null;
}

/* ------------------------- Completion helpers ------------------------- */

function collectPathSuggestions(
  moduleFiles: Iterable<string>,
  dirPrefix: string,
  namePrefix: string
): Array<{ label: string; insertText: string; isFolder: boolean }> {
  const map = new Map<string, { isFolder: boolean }>();

  for (const relFile of moduleFiles) {
    if (!relFile.startsWith(dirPrefix)) {
      continue;
    }

    const rest = relFile.slice(dirPrefix.length);
    if (!rest) {
      continue;
    }

    const slash = rest.indexOf('/');
    const isFolder = slash >= 0;
    const segment = isFolder ? rest.slice(0, slash) : rest;

    if (!segment.startsWith(namePrefix)) {
      continue;
    }

    const key = `${segment}|${isFolder ? 'd' : 'f'}`;
    if (!map.has(key)) {
      map.set(key, { isFolder });
    }
  }

  const out: Array<{ label: string; insertText: string; isFolder: boolean }> = [];
  for (const [key, meta] of map.entries()) {
    const [segment] = key.split('|');
    out.push({
      label: meta.isFolder ? `${segment}/` : segment,
      insertText: meta.isFolder ? `${segment}/` : segment,
      isFolder: meta.isFolder
    });
  }

  out.sort((a, b) => {
    if (a.isFolder !== b.isFolder) {
      return a.isFolder ? -1 : 1;
    }
    return a.label.localeCompare(b.label);
  });

  return out;
}

/* ------------------------- Config / State / Index ------------------------- */

function disposeState(state: WorkspaceState): void {
  for (const d of state.moduleWatchDisposables) {
    try {
      d.dispose();
    } catch {
      // ignore
    }
  }
  state.moduleWatchDisposables = [];
}

function disposeAllStates(): void {
  for (const st of states.values()) {
    disposeState(st);
  }
  states.clear();
}

async function reloadAllWorkspaceConfigs(): Promise<void> {
  disposeAllStates();

  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    await loadConfigForFolder(folder);
  }

  log(`Loaded configs for ${states.size}/${folders.length} workspace folder(s).`);
}

async function reloadConfigForUri(uri: vscode.Uri): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return;
  }
  await loadConfigForFolder(folder);
}

async function loadConfigForFolder(folder: vscode.WorkspaceFolder): Promise<void> {
  const key = folder.uri.toString();
  const prev = states.get(key);
  if (prev) {
    disposeState(prev);
    states.delete(key);
  }

  const cfgPath = path.join(folder.uri.fsPath, CONFIG_FILE_NAME);

  let raw: string;
  try {
    raw = await fs.readFile(cfgPath, 'utf8');
  } catch {
    log(`[${folder.name}] Config not found: ${cfgPath}`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log(`[${folder.name}] Invalid JSON in ${CONFIG_FILE_NAME}: ${String(err)}`);
    return;
  }

  const cfg = validateAndNormalizeConfig(parsed);
  if (!cfg) {
    log(`[${folder.name}] Invalid config schema in ${CONFIG_FILE_NAME}`);
    return;
  }

  if (!isValidPrefixTemplate(cfg.prefix)) {
    log(`[${folder.name}] Invalid prefix "${cfg.prefix}" (must contain exactly one "$MODULE").`);
    return;
  }

  const prefixParseRegex = buildPrefixParseRegex(cfg.prefix);

  const moduleAbsPaths = new Map<string, string>();
  for (const [moduleName, relPath] of Object.entries(cfg.modules)) {
    moduleAbsPaths.set(moduleName, path.resolve(folder.uri.fsPath, relPath));
  }

  const moduleConcretePrefixes = new Map<string, string>();
  for (const moduleName of Object.keys(cfg.modules)) {
    moduleConcretePrefixes.set(moduleName, cfg.prefix.replace('$MODULE', moduleName));
  }

  const modulesByConcretePrefixLengthDesc = [...moduleConcretePrefixes.keys()].sort((a, b) => {
    const pa = moduleConcretePrefixes.get(a) ?? '';
    const pb = moduleConcretePrefixes.get(b) ?? '';
    return pb.length - pa.length;
  });

  const state: WorkspaceState = {
    folder,
    config: cfg,
    moduleAbsPaths,
    moduleConcretePrefixes,
    modulesByConcretePrefixLengthDesc,
    prefixParseRegex,
    fileIndexByModule: new Map(),
    moduleWatchDisposables: []
  };

  states.set(key, state);

  await rebuildFileIndexForState(state);
  installModuleWatchers(state);

  log(
    `[${folder.name}] Config loaded. modules=${Object.keys(cfg.modules).length}, indexed=${state.fileIndexByModule.size}`
  );
}

async function rebuildAllFileIndexes(): Promise<void> {
  for (const state of states.values()) {
    await rebuildFileIndexForState(state);
    scheduleFolderDiagnosticsRefresh(state.folder);
  }
}

async function rebuildFileIndexForState(state: WorkspaceState): Promise<void> {
  state.fileIndexByModule.clear();

  for (const [moduleName, absRoot] of state.moduleAbsPaths.entries()) {
    try {
      const files = await indexAllFilesUnder(absRoot);
      state.fileIndexByModule.set(moduleName, new Set(files));
      log(`[${state.folder.name}] Indexed module "${moduleName}": ${files.length} files`);
    } catch (err) {
      log(`[${state.folder.name}] Failed to index module "${moduleName}": ${String(err)}`);
      state.fileIndexByModule.set(moduleName, new Set());
    }
  }
}

async function indexAllFilesUnder(rootAbsPath: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(currentAbs: string): Promise<void> {
    const entries = await fs.readdir(currentAbs, { withFileTypes: true });

    for (const e of entries) {
      const abs = path.join(currentAbs, e.name);

      if (e.isDirectory()) {
        await walk(abs);
        continue;
      }

      if (e.isFile()) {
        const rel = path.relative(rootAbsPath, abs).split(path.sep).join('/');
        out.push(rel);
      }
    }
  }

  await walk(rootAbsPath);
  return out;
}

function installModuleWatchers(state: WorkspaceState): void {
  // Dispose previous watchers if any
  for (const d of state.moduleWatchDisposables) {
    d.dispose();
  }
  state.moduleWatchDisposables = [];

  for (const [moduleName, moduleRootAbs] of state.moduleAbsPaths.entries()) {
    const pattern = new vscode.RelativePattern(moduleRootAbs, '**/*');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const onCreate = watcher.onDidCreate(async (uri) => {
      await onModuleFsEvent(state, moduleName, moduleRootAbs, uri, 'create');
    });

    const onChange = watcher.onDidChange(async (uri) => {
      await onModuleFsEvent(state, moduleName, moduleRootAbs, uri, 'change');
    });

    const onDelete = watcher.onDidDelete(async (uri) => {
      await onModuleFsEvent(state, moduleName, moduleRootAbs, uri, 'delete');
    });

    state.moduleWatchDisposables.push(watcher, onCreate, onChange, onDelete);
  }

  log(`[${state.folder.name}] Module watchers installed: ${state.moduleAbsPaths.size}`);
}

async function onModuleFsEvent(
  state: WorkspaceState,
  moduleName: string,
  moduleRootAbs: string,
  uri: vscode.Uri,
  kind: 'create' | 'change' | 'delete'
): Promise<void> {
  const set = state.fileIndexByModule.get(moduleName);
  if (!set) {
    return;
  }

  const rel = toModuleRelativePath(moduleRootAbs, uri.fsPath);
  if (!rel) {
    return;
  }

  if (kind === 'delete') {
    if (set.delete(rel)) {
      log(`[${state.folder.name}] index - ${moduleName}: ${rel}`);
      scheduleFolderDiagnosticsRefresh(state.folder);
    }
    return;
  }

  // create / change: keep in index only if it's a file
  if (await isFile(uri.fsPath)) {
    if (!set.has(rel)) {
      set.add(rel);
      log(`[${state.folder.name}] index + ${moduleName}: ${rel}`);
      scheduleFolderDiagnosticsRefresh(state.folder);
    }
  } else {
    // it may be a directory or disappeared quickly; ensure no stale file record
    if (set.delete(rel)) {
      log(`[${state.folder.name}] index - ${moduleName}: ${rel}`);
      scheduleFolderDiagnosticsRefresh(state.folder);
    }
  }
}

function toModuleRelativePath(moduleRootAbs: string, absPath: string): string | null {
  const rel = path.relative(moduleRootAbs, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep).join('/');
}

function validateAndNormalizeConfig(data: unknown): WorkspaceResolverConfig | null {
  if (!isObject(data)) {
    return null;
  }

  const prefix = typeof data.prefix === 'string' ? data.prefix : null;
  const modulesRaw = isObject(data.modules) ? data.modules : null;
  const extensionsRaw = Array.isArray(data.extensions) ? data.extensions : [];
  const languagesRaw = Array.isArray(data.languages) ? data.languages : [];
  const diagnosticsRaw = typeof data.diagnostics === 'boolean' ? data.diagnostics : false;
  const documentLinksRaw = typeof data.documentLinks === 'boolean' ? data.documentLinks : true;

  if (!prefix || !modulesRaw) {
    return null;
  }

  const modules: Record<string, string> = {};
  for (const [k, v] of Object.entries(modulesRaw)) {
    if (typeof v === 'string' && k.trim()) {
      modules[k] = v;
    }
  }

  const extensions = [
    ...new Set(
      extensionsRaw
        .filter((x): x is string => typeof x === 'string')
        .map((x) => (x.startsWith('.') ? x : `.${x}`))
    )
  ];

  const languages = [...new Set(languagesRaw.filter((x): x is string => typeof x === 'string'))];

  return {
    prefix,
    modules,
    extensions,
    languages,
    diagnostics: diagnosticsRaw,
    documentLinks: documentLinksRaw
  };
}

function isValidPrefixTemplate(prefix: string): boolean {
  const matches = prefix.match(/\$MODULE/g) ?? [];
  return matches.length === 1;
}

function buildPrefixParseRegex(prefixTemplate: string): RegExp {
  let src = escapeRegExp(prefixTemplate);
  src = src.replace('\\$MODULE', '(?<module>[^/\\\\:<>"\'\\s]+)');
  src = `^${src}(?<path>.*)$`;
  return new RegExp(src);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function log(message: string): void {
  const now = new Date().toISOString();
  output.appendLine(`[${now}] ${message}`);
}