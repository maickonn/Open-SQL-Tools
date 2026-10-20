# Open SQL Tools

A fast, modern desktop SQL client in the spirit of HeidiSQL, for **MySQL 5.7+**, **MariaDB 10.2+**, **PostgreSQL 15+**, **Firebird 2.5+** and **SQLite** (database files, using the SQLite bundled with Electron), with a built-in AI assistant (Anthropic and OpenAI) that can inspect and query your database. Dark theme by default, light theme available.

## Features

- **Session manager**: SQLite database files (create if missing, open read-only), folders, colors, SSH tunnels (password, key, agent), SSL/TLS, MariaDB `ed25519`/`parsec` accounts, startup scripts, keep-alive, import/export of sessions. Passwords and API keys are encrypted with the OS keychain (Electron `safeStorage`).
- **Object tree**: databases, schemas, tables, views, materialized views, procedures, functions, packages, triggers, events, sequences/generators, domains, exceptions and types, with filtering and context actions (create, drop, rename, duplicate, empty, maintenance).
- **Host tab**: process list (kill process or query), server variables, status and command statistics.
- **SQL editor** (Monaco): multiple tabs, dialect-aware highlighting, autocomplete from the live catalog, run all / current statement / selection, multiple result sets, error markers, EXPLAIN, formatter, query history, snippets, open/save files, transaction control (auto-commit, commit, rollback).
- **Data tab**: canvas-rendered grid (millions of rows), WHERE filter, sorting, paging, inline editing with insert/update/delete posted as SQL, NULL handling, value editor for long text, JSON and binary data, copy as TSV/CSV/SQL/Markdown/JSON.
- **Table editor**: columns, indexes, foreign keys, check constraints, table options and partitions (MySQL/MariaDB `PARTITION BY`, PostgreSQL declarative partitions) with a live preview of the generated `CREATE`/`ALTER` SQL. On SQLite, changes `ALTER TABLE` cannot make are applied by rebuilding the table in one transaction, keeping data, indexes, triggers, views and foreign keys.
- **Bulk table editor**: move tables to another database/schema, change engine, collation (optionally converting data), row format, tablespace or owner for many tables at once.
- **Copy table**: to another database, schema or server of the same engine family, with or without data (server-side `INSERT … SELECT` when possible, streamed otherwise).
- **Keyboard shortcuts**: every action can be rebound in Preferences → Keyboard shortcuts (with conflict detection).
- **Tools**: export grids (CSV, TSV, Excel XLSX, JSON, SQL, HTML, XML, Markdown, LaTeX), SQL dump of databases, run SQL files, CSV import, find text on server, user manager.
- **AI assistant**: streaming chat with tool use. Reads schema and data freely (inside a read-only transaction); any statement that changes data or schema needs your explicit approval.

## Architecture

Electron + TypeScript, Clean Architecture with MVVM in the renderer.

```
src/
  shared/          IPC contracts, worker RPC, DTOs (no runtime deps)
  domain/          ports (DbConnection, SchemaInspector, SqlDialect, LlmProvider, repositories),
                   SQL splitter/classifier, version capabilities
  application/     session service (runs in the DB worker), agent loop, connections, export/import
  infrastructure/  MySQL/MariaDB (mysql2), PostgreSQL (pg + pg-cursor), Firebird (node-firebird),
                   SQLite (node:sqlite in a child process), app persistence (node:sqlite),
                   safeStorage secrets, Anthropic/OpenAI providers, SSH
  main/            composition root, window, IPC handlers, session manager
  preload/         typed contextBridge API
  renderer/        React views + Zustand view models
```

Performance design:

- Every database session runs in its own Electron **utility process**; drivers never block the UI or the main process.
- Results stream from the worker straight to the renderer over a dedicated `MessagePort` as **columnar chunks**; the grid reads cells on demand and never copies rows into React state.
- Each session keeps a second connection for catalog browsing, kills and AI reads, so a long query never freezes the object tree.
- Monaco, the AI chat and the tool dialogs load lazily.

## Development

Requirements: Node.js 22.12+ and Docker (for test databases).

```bash
npm install
npm run dev
```

Other scripts:

| Script | What it does |
| --- | --- |
| `npm run typecheck` | Type-checks main/preload/worker and renderer |
| `npm test` | Unit tests |
| `npm run test:db -- mysql97 postgres18` | Starts only those database containers, runs the integration tests against them, then stops them |
| `DB_TARGETS=sqlite npx vitest run --project integration` | Integration tests for SQLite (temporary files, no container) |
| `npm run db:up -- mariadb118` / `npm run db:stop -- mariadb118` | Start/stop a single test server |
| `npm run test:e2e:db -- postgres18 firebird5` | Builds the app and runs the Playwright flow (connect, create, edit, copy, bulk/partition editors) against only those containers |
| `npm run build && OST_E2E_TARGETS=sqlite npx playwright test tests/e2e/engines.spec.ts` | The same flow for SQLite (no container) |
| `npm run test:e2e` | Builds and drives the real Electron app with Playwright (set `OST_E2E_MYSQL_PORT=33097` with `mysql97` running for the connected scenario) |
| `npm run dist` | Builds installers with electron-builder |

### Test databases

`docker/compose.yml` defines one service per supported server version, with no volumes (each start is clean). Start only what you are testing; running the whole matrix at once is too heavy for Docker Desktop.

| Engine | Services (host port) |
| --- | --- |
| Firebird | `firebird25` (30250, built from the official 2.5.9 tarball), `firebird3` (30300), `firebird4` (30400), `firebird5` (30500), `firebird6` (30600, snapshot, `preview` profile) |
| MySQL | `mysql57` (33057), `mysql80` (33080), `mysql84` (33084), `mysql97` (33097), `mysql267` (33267) |
| MariaDB | `mariadb102` … `mariadb130` (34102 … 34130) |
| PostgreSQL | `postgres15` … `postgres18` (35415 … 35418), `postgres19` (35419, RC, `preview` profile) |

The `tools` profile adds `sshd` (port 2222, user/password `tunnel`, throwaway key `docker/sshd/test_key`; reach databases by service name, e.g. `mysql97:3306`) and `postgres18ssl` (port 35428, TLS on).

Credentials: MySQL/MariaDB `root`/`test`, PostgreSQL `postgres`/`test`, Firebird `SYSDBA`/`masterkey`. Each server has a `testdb` database (Firebird: `/var/lib/firebird/data/testdb.fdb`).
