# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Open SQL Tools is an Electron + TypeScript desktop SQL client aiming at feature parity with HeidiSQL (MySQL 5.7+, MariaDB 10.2+, PostgreSQL 15+, Firebird 2.5+) plus an agentic AI chat (Anthropic/OpenAI). Application performance is a primary requirement.

## Conventions

- All code, identifiers, comments and commit messages must be written in English. The UI is English-only; every user-visible string still goes through i18next (`src/renderer/i18n/en.ts`), never hardcoded in components.
- Never add Docker volumes, and never start the whole database matrix (Docker Desktop crashes). Start only the services being tested and stop them afterwards — the `test:db` / `test:e2e:db` scripts do this.
- Supported AI models are a fixed list (`AI_MODELS` in `src/shared/model.ts`); `resolveAiModel` maps anything else to the provider default. Don't reintroduce free-form model ids or API model listing.

## Commands

```bash
npm run dev                 # electron-vite dev (HMR renderer)
npm run build               # bundles main, preload, worker and renderer into out/
npm run typecheck           # tsc for tsconfig.node.json (main/preload/worker/app layers) and tsconfig.web.json (renderer)
npm test                    # unit tests (vitest project "unit")
npx vitest run --project unit tests/unit/splitter.test.ts -t "DELIMITER"   # single file / single test
npm run test:db -- mysql97 postgres18          # up only these containers, run integration tests, stop them (--keep to leave them up)
npm run test:e2e:db -- postgres18 firebird5    # build + Playwright Electron flow against only these containers
npm run dist                # electron-builder installers
```

- Integration tests (`tests/integration`) select servers through `DB_TARGETS` (comma-separated compose service names, see `tests/integration/targets.ts`); tests for servers that aren't reachable are skipped. `PERF=1` enables the benchmarks: `perf.test.ts` (1M-row streaming) and `sshPerf.test.ts` (object-tree browsing through the `sshd` tunnel with simulated latency, `PERF_RTT_MS`, default 60; prints timings in round trips). `connectivity.test.ts` needs the `tools` profile services (`sshd`, `postgres18ssl`).
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
    sql/                      splitter.ts (per-dialect script splitting), classifier.ts (read-only vs dangerous)
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
    db/common/                baseDialect, columnar chunk builder, query helpers
    db/openDatabase.ts        engine factory
    db/worker/connectionWorker.ts   utilityProcess entry (one per session)
    llm/                      Anthropic and OpenAI LlmProvider adapters
    persistence/sqliteStore.ts      node:sqlite (settings, sessions, history, snippets, chats)
    security/, ssh/, fs/      safeStorage secrets, ssh2 tunnels, file writer/reader
  main/                       composition root: index.ts, window.ts, ipc.ts, providers.ts,
                              agentGateway.ts, sessions/sessionManager.ts (spawns workers, brokers ports)
  preload/                    contextBridge API (index.ts + api.d.ts)
  renderer/
    App.tsx, main.tsx         shell, lazy dialogs, global shortcuts
    gateways/                 api.ts (IPC client), sessionClient.ts (worker RPC client)
    stores/                   Zustand view models (workspace, query, connections, chat, settings, ui, toast)
    views/                    TitleBar, StatusBar, LogPanel, sidebar/ (object tree), workspace/ (Host, Database,
                              Query, Object tabs), object/ (Data grid tab, StructureEditor), dialogs/, chat/
    components/               ui/ (Radix-based primitives), grid/ (Glide Data Grid), editor/ (Monaco)
    lib/                      resultSet.ts (columnar result store), shortcuts.ts, tabPersistence, clipboard, format
    i18n/                     en.ts (UI strings)
tests/
  unit/                       pure logic: splitter, classifier, dialects, agent loop, shortcuts, csv, auth
  integration/                real servers via DB_TARGETS (targets.ts lists services/ports)
  e2e/                        Playwright driving the built Electron app
docker/                       compose.yml (one service per server version; profiles latest/all/preview/tools),
                              firebird25/ custom image, sshd/ test SSH server
scripts/                      test-db.mjs, test-e2e-db.mjs (start only the given containers, test, stop)
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
- node-firebird uses `sequentially` with array rows, `blobAsText` and string numerics; queries must run inside transactions. Firebird 2.5 lacks boolean select expressions — use `CASE`.

`domain/sql/splitter.ts` splits scripts per dialect (MySQL `DELIMITER`, Firebird `SET TERM` and PSQL blocks, PostgreSQL dollar quoting); `classifier.ts` decides which statements are read-only vs dangerous (used for confirmation dialogs and AI approval).

### Renderer details

Heavy pieces (Monaco, chat, tool dialogs) are lazy-loaded. Monaco is bundled locally (`renderer/components/editor/monaco.ts`), not from a CDN. Dialogs are opened through `uiStore.openDialog({ kind })` and rendered lazily in `App.tsx`. Use the in-app `confirmDialog` rather than `window.confirm`. Keyboard shortcuts come from the registry in `renderer/lib/shortcuts.ts` (user overrides live in `AppSettings.shortcuts`). Theming is CSS variables consumed by Tailwind v4 `@theme inline`.

### AI agent

`application/chat/agentService.ts` runs the tool loop against the `LlmProvider` port (`infrastructure/llm/anthropicProvider.ts` uses the beta Messages streaming API with adaptive thinking and prompt caching; `openaiProvider.ts` uses the stateless Responses API with encrypted reasoning). Provider-native assistant content is stored in `providerData` and replayed verbatim. Read tools run in read-only transactions on the meta connection; `execute_sql` always waits for UI approval.
