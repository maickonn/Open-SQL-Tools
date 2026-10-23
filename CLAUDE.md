# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Open SQL Tools is an Electron + TypeScript desktop SQL client aiming at feature parity with HeidiSQL (MySQL 5.7+, MariaDB 10.2+, PostgreSQL 15+, Firebird 2.5+, SQLite files) plus an agentic AI chat (Anthropic/OpenAI). It ships for Windows (x64) and macOS (Apple Silicon only); Linux is not supported. Application performance is a primary requirement.

## Conventions

- All code, identifiers, comments and commit messages must be written in English. The UI is English-only; every user-visible string still goes through i18next (`src/renderer/i18n/en.ts`), never hardcoded in components.
- Never add Docker volumes, and never start the whole database matrix (Docker Desktop crashes). Start only the services being tested and stop them afterwards — the `test:db` / `test:e2e:db` scripts do this.
- Keep the task/todo list current: mark each task complete as soon as it is done and start the next one right away, instead of updating the list in batches at the end.
- Supported AI models are a fixed list (`AI_MODELS` in `src/shared/model.ts`); `resolveAiModel` maps anything else to the provider default. Don't reintroduce free-form model ids or API model listing.
- When asked to change the version, also add a `## [x.y.z]` section to `CHANGELOG.md` listing what is new since the previous version (user-facing changes, from `git log v<previous>..HEAD` plus anything under `## [Unreleased]`, which is then left empty). The release workflow fails without that section, and the update splash shows its first items.

## Commands

```bash
npm run dev                 # electron-vite dev (HMR renderer)
npm run build               # bundles main, preload, worker and renderer into out/
npm run typecheck           # tsc for tsconfig.node.json (main/preload/worker/app layers) and tsconfig.web.json (renderer)
npm test                    # unit tests (vitest project "unit")
npx vitest run --project unit tests/unit/splitter.test.ts -t "DELIMITER"   # single file / single test
npm run test:db -- mysql97 postgres18          # up only these containers, run integration tests, stop them (--keep to leave them up)
npm run test:e2e:db -- postgres18 firebird5    # build + Playwright Electron flow against only these containers
DB_TARGETS=sqlite npx vitest run --project integration                       # SQLite integration tests (temp files, no Docker)
OST_E2E_TARGETS=sqlite npx playwright test tests/e2e/engines.spec.ts         # SQLite E2E after npm run build
npm run package             # electron-builder into release/: Windows NSIS installer, macOS arm64 dmg (--win / --mac)
npm run demo                # build + record docs/demo.gif (scripts/demo: Playwright storyboard, CDP frames, ffmpeg)
node scripts/render-icon.mjs   # resources/icon.svg → icon.png (1024), icon.ico (16–256) and renderer assets/logo.svg
```

- Use Node 24 (as CI): the SQLite integration tests run `sqliteProcess.mts` with Node's type stripping, which older versions lack (Node 20 fails every SQLite test).
- Integration tests (`tests/integration`) select servers through `DB_TARGETS` (comma-separated compose service names, see `tests/integration/targets.ts`); tests for servers that aren't reachable are skipped. The `sqlite` target needs no container and is always available; `sqlite.test.ts` covers the SQLite-only behaviour (file options, table rebuilds, dumps). `PERF=1` enables the benchmarks: `perf.test.ts` (1M-row streaming) and `sshPerf.test.ts` (object-tree browsing through the `sshd` tunnel with simulated latency, `PERF_RTT_MS`, default 60; prints timings in round trips). `connectivity.test.ts` needs the `tools` profile services (`sshd`, `postgres18ssl`).
- CI (`.github/workflows/ci.yml`) runs one job per compose service (each starts only its own container), the Electron E2E under `xvfb-run`, and builds the Windows installer and the macOS dmg; `release.yml` runs on `v*` tags, requires the tag to equal `v` + the `package.json` version (bump with `npm version`), takes the release notes from that version's `CHANGELOG.md` section (`scripts/release-notes.mjs`; add user-facing changes under `## [Unreleased]`), and uploads the Windows installer plus `latest.yml` (windows-latest) and the macOS dmg plus `latest-mac.yml` (macos-latest) to a draft release that is published by hand. `firebird6` (`6-snapshot`) and `postgres19` follow upstream snapshots, so they can break without a code change: compare with the previous commit before blaming the latest one.
- E2E (`tests/e2e`) uses Playwright `_electron` against `out/`, so always build first. `OST_E2E_TARGETS` selects engines for `engines.spec.ts`; `OST_USER_DATA` gives the app an isolated profile directory.
- Service names, ports and credentials are in `docker/compose.yml` and the README (MySQL/MariaDB `root`/`test`, PostgreSQL `postgres`/`test`, Firebird `SYSDBA`/`masterkey`, database `testdb`). Firebird 2.5 is a custom image built from the official tarball (`docker/firebird25`).

## Project structure

```
src/
  shared/                     no runtime deps; imported by every process
    model.ts                  DTOs and settings (ConnectionProfile, TableStructure, AppSettings, AI_MODELS, chat types)
    ipc.ts                    typed renderer ⇄ main channels (IpcInvokeMap, IpcEventMap)
    workerApi.ts, rpc.ts      typed renderer ⇄ DB worker RPC over MessagePort
  domain/                     pure logic + ports
    ports/                    database.ts (DbConnection, SchemaInspector, SqlDialect), llm.ts, repositories.ts
    sql/                      splitter.ts (per-dialect script splitting), classifier.ts (read-only vs dangerous),
                              intellisense/ (lexer, statement context, dialect keywords/functions, diagnostics)
    serverVersion.ts          version → capability flags
  application/                use cases
    session/sessionService.ts everything a DB session does (runs inside the worker)
    chat/                     agentService.ts (tool loop, approvals), agentTools.ts (tool schemas + execution)
    copy/, export/, import/   copy table, export formatters (CSV…XLSX), CSV import
    connections/              session profiles + secrets
  infrastructure/
    db/mysql-family/          mysql2 connection, MySQL/MariaDB dialect + inspector, MariaDB auth plugins
    db/postgres/              pg + pg-cursor connection, dialect, inspector
    db/firebird/              node-firebird connection, dialect, inspector
    db/sqlite/                node:sqlite in a child process (sqliteProcess.mts), connection, dialect, inspector
    db/common/                baseDialect, columnar chunk builder, query helpers
    db/openDatabase.ts        engine factory
    db/worker/connectionWorker.ts   utilityProcess entry (one per session)
    llm/                      Anthropic and OpenAI LlmProvider adapters
    persistence/sqliteStore.ts      node:sqlite (settings, sessions, history, snippets, chats)
    security/, ssh/, fs/      safeStorage secrets, ssh2 tunnels, file writer/reader
  main/                       composition root: index.ts, window.ts, ipc.ts, providers.ts, appMenu.ts (macOS menu bar),
                              agentGateway.ts, sessions/sessionManager.ts (spawns workers, brokers ports)
  preload/                    contextBridge API (index.ts + api.d.ts)
  renderer/
    App.tsx, main.tsx         shell, lazy dialogs, global shortcuts
    gateways/                 api.ts (IPC client), sessionClient.ts (worker RPC client)
    stores/                   Zustand view models (workspace, query, connections, chat, settings, ui, toast)
    views/                    TitleBar, StatusBar, LogPanel, sidebar/ (object tree), workspace/ (Host, Database,
                              Query, Object tabs), object/ (Data grid tab, StructureEditor), dialogs/, chat/
    components/               ui/ (Radix-based primitives), grid/ (Glide Data Grid), editor/ (Monaco)
    lib/                      resultSet.ts (columnar result store), shortcuts.ts, nativeMenu.ts, tabPersistence,
                              clipboard, format
    i18n/                     en.ts (UI strings)
tests/
  unit/                       pure logic: splitter, classifier, dialects, agent loop, shortcuts, csv, auth
  integration/                real servers via DB_TARGETS (targets.ts lists services/ports)
  e2e/                        Playwright driving the built Electron app
docker/                       compose.yml (one service per server version; profiles latest/all/preview/tools),
                              firebird25/ custom image, sshd/ test SSH server
scripts/                      test-db.mjs, test-e2e-db.mjs (start only the given containers, test, stop),
                              release-notes.mjs, adhoc-sign.mjs (macOS afterPack), render-icon.mjs, demo/
```

## Architecture: Clean Architecture + MVVM

The backend (main process + DB workers) follows Clean Architecture; the renderer follows MVVM. They meet at the contracts in `src/shared`.

### Clean Architecture layers (backend)

Dependencies point inward only: `infrastructure` / `main` → `application` → `domain` → `shared`.

| Layer | Role | May import | Must not |
|---|---|---|---|
| `shared` | Contracts crossing process boundaries: DTOs (`model.ts`), IPC map (`ipc.ts`), worker RPC (`workerApi.ts`, `rpc.ts`) | nothing | import Node, Electron or React |
| `domain` | Ports (interfaces) and pure business rules: `ports/database.ts`, `ports/llm.ts`, `ports/repositories.ts`, SQL splitter/classifier, version capabilities | `shared` | touch drivers, I/O or Electron |
| `application` | Use cases orchestrating ports: `SessionService`, `AgentService`, `ConnectionService`, copy table, export/import | `domain`, `shared` | instantiate concrete drivers/SDKs; dependencies arrive through constructor `deps` objects |
| `infrastructure` | Adapters implementing the ports: mysql2/pg/node-firebird connections, dialects and inspectors, Anthropic/OpenAI providers, SQLite repositories, safeStorage, ssh2, file I/O | all inner layers | be imported by `domain`/`application` |
| `main` | Composition roots and delivery: wires adapters into use cases and exposes them over IPC | everything | contain business logic |

There are two composition roots: `src/main/index.ts` (builds `SqliteStore`, `SafeStorageSecretStore`, `ConnectionService`, `AgentService`, `ProviderRegistry`, then `registerIpc`) and `src/infrastructure/db/worker/connectionWorker.ts` (builds a `SessionService` with `openDatabase`, `openSshTunnel` and the file writer inside each utility process). Dependency injection is manual: use cases receive a `deps` object of ports, which is also how unit tests substitute fakes (see `tests/unit/agent.test.ts`).

Typical flow for a new backend capability: define/extend the port in `domain/ports`, implement it per engine in `infrastructure/db/*`, orchestrate it in an `application` service, expose it in `shared/workerApi.ts` (session work) or `shared/ipc.ts` (app-level work) plus the matching handler (`connectionWorker.ts` `METHODS` or `main/ipc.ts`).

### MVVM (renderer)

| MVVM role | Where | Notes |
|---|---|---|
| Model | `shared/model.ts` DTOs, reached through **gateways**: `renderer/gateways/api.ts` (typed IPC to main via preload) and `gateways/sessionClient.ts` (typed RPC straight to the session worker) | Large results live outside React in `lib/resultSet.ts` (columnar store) |
| ViewModel | Zustand stores in `renderer/stores`: `workspaceStore` (sessions, tabs, tree), `queryStore` (execution, results, transactions), `connectionsStore`, `chatStore`, `settingsStore`, `uiStore` (dialogs, panels), `toast` | Hold state and expose commands (`execute`, `openTable`, `send`…); they are the only place that should talk to gateways |
| View | React components in `renderer/views` (screens) and `renderer/components` (reusable UI, grid, editor) | Read state with granular selectors (`useWorkspace((s) => s.x)`) and call view-model commands; no business logic |

The renderer can't import `application`/`infrastructure` (only `shared`, `domain` and the side-effect-free `application/import` and `application/copy`, as listed in `tsconfig.web.json`). Some dialogs and views still call `api.invoke` directly for simple one-off reads; new logic with state belongs in a store.

### Process model (the core performance design)

- **Main process** (`src/main`): composition root, window, IPC handlers (`ipc.ts`, typed by `IpcInvokeMap` in `src/shared/ipc.ts`), SQLite persistence (`node:sqlite`, no native modules), `safeStorage` secrets, AI agent loop (`agentGateway.ts` + `application/chat`).
- **One Electron `utilityProcess` per DB session** (`infrastructure/db/worker/connectionWorker.ts` → `out/main/connectionWorker.js`). It hosts `application/session/sessionService.ts` and the drivers. The main process only brokers a `MessagePort`; the renderer then talks to the worker directly via `RpcEndpoint` (`src/shared/rpc.ts`), typed by `src/shared/workerApi.ts`. A new worker method must be added to `workerApi.ts`, `SessionService`, and the `METHODS` list in `connectionWorker.ts`.
- Each session holds a **primary connection** (user queries) and a **meta connection** guarded by a mutex (catalog browsing, kills, AI reads), so long queries never block the object tree. Both are opened concurrently in `openDatabase.ts`.
- **Round trips are the main cost over SSH/WAN links.** Catalog queries go through `metaQuery` with `RunOptions.direct` (no server-side cursor, one round trip); prefer one combined query (e.g. `UNION ALL`) over several sequential ones in inspectors. The SSH tunnel disables Nagle (`setNoDelay`) on both legs. Measure changes with `sshPerf.test.ts`.
- Query results stream as **columnar chunks** (`infrastructure/db/common/columnar.ts`) into `renderer/lib/resultSet.ts`, which the canvas grid (Glide Data Grid, `renderer/components/grid`) reads on demand. Rows never go into React state; notifications are rAF-coalesced.

### Database engines

Each engine in `infrastructure/db/{mysql-family,postgres,firebird}` implements the domain ports in `domain/ports/database.ts`: `DbConnection` (driver + streaming), `SchemaInspector` (catalog queries), `SqlDialect` (DDL/DML generation; shared base in `db/common/baseDialect.ts`). MariaDB reuses the MySQL family with its own dialect/inspector subclasses. Version differences are expressed as capability flags from `domain/serverVersion.ts`, not ad-hoc version checks.

Driver quirks the code depends on:
- mysql2 runs with `rowsAsArray`, `dateStrings`, `jsonStrings`; MariaDB `client_ed25519` and `parsec` auth are implemented in `mysql-family/mariadbAuth.ts` and passed via `authPlugins`.
- pg uses custom type parsers to keep exact text values and `pg-cursor` for streaming user queries. PostgreSQL can't switch databases on a live connection, so `PgConnection.useDatabase` parks the current client per database (up to 4 idle, LRU) and reuses it when switching back; the handshake loads server info and `pg_type` in a single multi-statement query.
- node-firebird uses `sequentially` with array rows, `blobAsText` and string numerics; queries must run inside transactions. Firebird 2.5 lacks boolean select expressions — use `CASE`. `fbConnection.ts` patches the driver's output message format: NONE and OCTETS text is declared with its own charset (`blr_text2`/`blr_varying2`) instead of the connection's, because Firebird 6 transliterates it and then fails with "string right truncation" or "Malformed string"; `fitOutputMessage` keeps columns the driver widens for UTF8 within the 64 KB message.
- SQLite uses Node's built-in `node:sqlite` (no native module). It is synchronous and has no interrupt, so each connection runs in a child process (`sqlite/sqliteProcess.mts`, forked with `ELECTRON_RUN_AS_NODE`; a worker thread cannot be stopped while SQLite's native code runs). Cancel = kill + reopen. The `.mts` script must stay self-contained (built-ins and type-only imports): the bundle ships it as `out/main/sqliteProcess.js`, while integration tests run the source with Node's type stripping. Read-only runs set `PRAGMA query_only`. `PRAGMA foreign_keys` is a no-op inside transactions, so `SqliteConnection` applies OFF before the auto-started transaction and defers ON until it ends — table rebuilds (`SqliteDialect.rebuild`, SQLite's 12-step procedure) rely on this so `DROP TABLE` doesn't fire `ON DELETE` actions.
- Firebird text without a charset (CHARACTER SET NONE, or columns falling back to a NONE database default) is plain bytes, possibly in different encodings per value. On UTF8 connections `firebird/fbLegacyText.ts` patches node-firebird's text decoders so NONE values (and text BLOBs that aren't valid UTF-8) arrive as `LegacyText` bytes; `FbConnection` holds the first rows of a result, feeds every value to the session's `EncodingProfiles` (`domain/text/legacyText.ts`, shared by both connections via `OpenDatabase.textProfiles`) and decodes each value as ASCII, strict UTF-8 or the column's single-byte code page (plausibility-scored among Windows-1252, DOS 850, Windows-1250/1251, KOI8-R, DOS 866; Windows-1252 unless another wins clearly). `application/session/legacyTextWriter.ts` writes text back in the cell's own encoding, else the column's, the table's declared charsets, the database default, the whole database's evidence, then UTF-8 (hex literals for CHAR/VARCHAR, bound bytes for BLOBs), turns non-ASCII NONE keys into `{ anyOf }` alternatives, and `SessionService.sendable` rewrites typed SQL with `domain/sql/legacyLiterals.ts` (comparisons expand to every encoding the column holds, assignments use its encoding; DDL and PSQL untouched).
- Single-database engines (Firebird, SQLite) address objects without a database; use the helpers in `domain/engineTraits.ts` (`isSingleDatabase`, `isFileBased`, `hasTransactionalDdl`, `hasBulkTableOptions`) instead of comparing engine names.

`domain/sql/splitter.ts` splits scripts per dialect (MySQL `DELIMITER`, Firebird `SET TERM` and PSQL blocks, PostgreSQL dollar quoting, SQLite trigger bodies and `[identifiers]`); `classifier.ts` decides which statements are read-only vs dangerous (used for confirmation dialogs and AI approval).

Editor IntelliSense: `domain/sql/intellisense` is pure (no Monaco) and unit-tested: `analyzeStatement` finds the row sources (tables, aliases, CTEs, derived tables) and what fits at the cursor, `diagnose` flags only certain errors (unknown tables, `alias.column`). The catalog comes from the batch RPCs `listColumns`/`listRoutines` (one query per schema, cached in `renderer/lib/sqlCatalog.ts` until DDL, a tree refresh or session close). `components/editor/sqlIntellisense.ts` registers the Monaco providers; `monaco.ts` imports the suggest/hover/parameter-hints contributions explicitly because `editor.api` is the bare editor.

Grid editing lives in `views/object/EditableGrid.tsx` (edits, posting through `applyRowChanges`, value editor, LOB loading, import/export), shared by the Data tab (`DataView`: filter, paging, lazy LOB previews) and query results: `QueryView`'s result pane asks the worker for `resultSource` (the single table behind the result columns — `ColumnMeta.table`/`orgName`/`database`, or PostgreSQL's `tableOid`/`columnNum` resolved by `PgInspector.columnSources`) and, when the result holds the table's key (`tableKey`), edits it in place, patching the result with `ResultSet.withEdits` after posting. Large objects in the Data tab: for tables with a key, `domain/lob.ts` `lobKind` marks BLOB/TEXT/bytea columns, `TableDataRequest.lazy` makes the dialect select a preview (the first `LOB_PREVIEW_CHARS` characters plus `LOB_CUT_MARK`, appended by the server when it cut the value: the client can't tell from the length, because invalid bytes decode to fewer characters) or `OCTET_LENGTH` instead, and `DataView` fetches values by key (`fetchCellValues`, meta connection) when a cell is opened, edited or copied. The result keeps the full-value SQL in `rs.sql` for exports. The value editor (`views/object/ValueEditorDialog.tsx`) sniffs files with `domain/fileType.ts` `detectFileType` (magic numbers), previews images (`<img>`) and PDFs (Chromium's viewer in an `<iframe>`, hence `frame-src blob:` in the CSP) from blob URLs, and imports/exports through `fs:readBytes`/`fs:writeBytes` (`lib/valueFiles.ts`, also from the cell menu of LOB columns, `lobColumnKind`); grid edits run through `SqlDialect.boundRowChanges`, which binds binary values as parameters (`RunOptions.params`; Firebird casts them to `BLOB SUB_TYPE BINARY` so files in text BLOBs keep their bytes) because literals overflow Firebird 2.5's 64 KB statements; text previews in single-byte charsets are turned back into bytes with `textBytes` to sniff the type, but the full value of a file in a text LOB is read with `fetchCellBytes` (`SqlDialect.selectLobBytes`: OCTETS chunks in an `EXECUTE BLOCK` on Firebird, `CAST(… AS BINARY)` on MySQL), because Firebird's transliteration turns the bytes WIN1252 lacks (0x81, 0x8D, 0x8F, 0x90, 0x9D) into 0x00. Firebird reads BLOBs with `blobReadChunkSize: 65535` (the driver default of 1 KB costs one round trip per KB).

### Renderer details

Heavy pieces (Monaco, chat, tool dialogs) are lazy-loaded. Monaco is bundled locally (`renderer/components/editor/monaco.ts`), not from a CDN. On macOS the title bar has no menus: `TitleBar` sends the same menus to the native menu bar (`lib/nativeMenu.ts` → `menu:set` → `main/appMenu.ts`), and clicks come back as `menu:command` with the item id. Dialogs are opened through `uiStore.openDialog({ kind })` and rendered lazily in `App.tsx`. Use the in-app `confirmDialog` rather than `window.confirm`. Keyboard shortcuts come from the registry in `renderer/lib/shortcuts.ts` (user overrides live in `AppSettings.shortcuts`); they are stored as `Ctrl+…` and matched with Ctrl or ⌘, so show them through `displayShortcut` (macOS symbols such as ⇧⌘F, ⌃⇥ for tabs) and never hardcode `Ctrl+` in labels. On macOS the page sees keys before the native menu: a shortcut the page handles (`preventDefault`) never reaches the menu, one it ignores runs the menu item's accelerator. Theming is CSS variables consumed by Tailwind v4 `@theme inline`.

### Auto update

Windows and macOS installs check GitHub releases on startup (`electron-builder.yml` `publish`). `application/update/updateService.ts` drives the splash (check with a timeout, available, cancellable download, ready, failed) over the `UpdateSource` port (`domain/ports/updater.ts`); `infrastructure/update/electronUpdateSource.ts` adapts `electron-updater` (no auto download, silent NSIS install on restart). `main/index.ts` shows the splash (`renderer/splash.html`, a second renderer entry) before creating the main window, only when packaged on Windows or macOS, `checkForUpdates` is on and `OST_USER_DATA` is unset. The macOS build is arm64 only and unsigned (signed ad hoc by the `afterPack` hook `scripts/adhoc-sign.mjs`, since electron-builder's own ad hoc signing fails), so Squirrel.Mac can't install updates: there the splash's **Download** calls `UpdateService.openReleasePage` (the release page in the browser), which waits until the system has the URL (`shell.openExternal`, capped at 3 s, failures ignored, the button spinning meanwhile; quitting first could drop it) and always ends with the `'quit'` outcome so the new disk image can replace the app. `OST_SPLASH_PREVIEW=update|offline|latest` uses `PreviewUpdateSource` to show it in dev.

### README demo

`scripts/demo/record.mjs` seeds a SQLite shop database (`seed.mjs`), drives the built app through a fixed storyboard, draws captions, title cards and a cursor with an injected DOM layer (`overlay.mjs`), captures frames with CDP `Page.startScreencast` and encodes `docs/demo.gif` with ffmpeg. `OST_DEMO_AI=1` replaces every AI provider with `infrastructure/llm/demoProvider.ts` (a scripted `run_select` turn answered from the real result) and makes `ai:hasKey` report true. Re-record after UI changes that the storyboard touches; `DEMO_DEBUG=1` prints scene timings and saves a screenshot per scene in `out/demo`.

### AI agent

`application/chat/agentService.ts` runs the tool loop against the `LlmProvider` port (`infrastructure/llm/anthropicProvider.ts` uses the beta Messages streaming API with adaptive thinking and prompt caching; `openaiProvider.ts` uses the stateless Responses API with encrypted reasoning). Provider-native assistant content is stored in `providerData` and replayed verbatim. Read tools run in read-only transactions on the meta connection; `execute_sql` always waits for UI approval.
