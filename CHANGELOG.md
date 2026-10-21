# Changelog

User-facing changes per release. Add entries under **Unreleased** as you go; before tagging, rename it to the new version (the release workflow copies that section into the GitHub release, and the update splash shows its first items).

## [Unreleased]

## [0.1.2]

- Firebird 2.5 no longer crashes when a query reads very wide CHARACTER SET NONE columns
- Query results are no longer limited to 100,000 rows

## [0.1.1]

- First release: desktop SQL client for MySQL, MariaDB, PostgreSQL, Firebird and SQLite
- AI assistant (Anthropic and OpenAI) that reads the schema and asks before changing data
- Table, trigger and bulk table editors that show the SQL before running it
- Fast data grid, SQL editor with autocomplete, exports, dumps and SSH tunnels
- Automatic updates on Windows
