# Changelog

User-facing changes per release. Add entries under **Unreleased** as you go; before tagging, rename it to the new version (the release workflow copies that section into the GitHub release, and the update splash shows its first items).

## [Unreleased]

- Value editor previews images and PDFs stored in BLOBs (also images kept in text BLOBs) and exports any value to a file
- Binary values show in the grid as their file type, e.g. (PNG), or (BLOB) when the type is unknown
- Firebird text BLOB previews keep the column charset (accents no longer break in databases with charset NONE)
- Data tab loads large objects (BLOB, TEXT, bytea) on demand: tables with heavy BLOB columns open in a fraction of the time
- Firebird BLOBs are read in 64 KB requests instead of 1 KB, so queries returning BLOBs no longer stall the session

## [0.1.5]

- New, sharper application icon (crisp at every size on Windows)

## [0.1.4]

- AI chat supports GPT 5.6 Terra
- Format SQL keeps the formatted text in view and the focus in the editor

## [0.1.3]

- SQL IntelliSense: context-aware completion of tables, columns, aliases, functions and routines
- Hover shows column types and keys; signature help for functions and procedures
- Warnings for unknown tables and columns while typing
- Right-click menu in SQL editors (run, clipboard, format)
- Format SQL uses a cleaner layout: one item per line, joins with ON below, 4-space indentation

## [0.1.2]

- Firebird 2.5 no longer crashes when a query reads very wide CHARACTER SET NONE columns
- Query results are no longer limited to 100,000 rows

## [0.1.1]

- First release: desktop SQL client for MySQL, MariaDB, PostgreSQL, Firebird and SQLite
- AI assistant (Anthropic and OpenAI) that reads the schema and asks before changing data
- Table, trigger and bulk table editors that show the SQL before running it
- Fast data grid, SQL editor with autocomplete, exports, dumps and SSH tunnels
- Automatic updates on Windows
