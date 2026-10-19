/** English UI strings. */
export const en = {
  app: { name: 'Open SQL Tool' },
  common: {
    ok: 'OK', cancel: 'Cancel', save: 'Save', delete: 'Delete', close: 'Close', apply: 'Apply', discard: 'Discard', refresh: 'Refresh',
    add: 'Add', remove: 'Remove', edit: 'Edit', copy: 'Copy', duplicate: 'Duplicate', rename: 'Rename', search: 'Search', filter: 'Filter',
    yes: 'Yes', no: 'No', none: 'None', name: 'Name', type: 'Type', value: 'Value', comment: 'Comment', loading: 'Loading…', error: 'Error',
    browse: 'Browse…', default: 'Default', rows: '{{count}} rows', row: 'row', columns: 'Columns', create: 'Create', open: 'Open',
    schema: 'Schema', sql: 'SQL', moveUp: 'Move up', moveDown: 'Move down', more: 'More', back: 'Back', next: 'Next', done: 'Done', running: 'Running…', confirm: 'Confirm'
  },
  menu: {
    file: 'File', edit: 'Edit', query: 'Query', tools: 'Tools', view: 'View', help: 'Help',
    sessionManager: 'Session manager…', newQueryTab: 'New query tab', openSqlFile: 'Open SQL file…', saveSqlFile: 'Save SQL file…',
    saveSqlFileAs: 'Save SQL file as…', closeTab: 'Close tab', disconnect: 'Disconnect', exit: 'Exit',
    runAll: 'Run', runCurrent: 'Run current statement', runSelection: 'Run selection', stop: 'Stop', explain: 'Explain',
    format: 'Format SQL', commit: 'Commit', rollback: 'Rollback', autocommit: 'Auto-commit',
    exportGrid: 'Export grid rows…', dumpSql: 'Export database as SQL…', importSql: 'Run SQL file…', importCsv: 'Import CSV file…',
    findText: 'Find text on server…', userManager: 'User manager…', maintenance: 'Maintenance', settings: 'Preferences…',
    toggleSidebar: 'Toggle sidebar', toggleLog: 'Toggle SQL log', toggleChat: 'Toggle AI assistant', theme: 'Theme',
    themeDark: 'Dark', themeLight: 'Light', themeSystem: 'System', about: 'About', shortcuts: 'Keyboard shortcuts'
  },
  sessions: {
    title: 'Session manager', newSession: 'New session', newFolder: 'New folder', connect: 'Open', test: 'Test',
    testOk: 'Connected to {{label}}', importSessions: 'Import…', exportSessions: 'Export…', empty: 'No saved sessions yet',
    filter: 'Filter sessions', exported: '{{count}} sessions exported to {{file}}', imported: '{{count}} sessions imported', engine: 'Network type', host: 'Hostname / IP', port: 'Port', user: 'User', password: 'Password',
    passwordSaved: 'Saved — leave empty to keep', savePassword: 'Save password (encrypted)', database: 'Database(s)',
    databaseFb: 'Database file (path or alias)', databasePg: 'Database', folder: 'Folder', color: 'Color', settings: 'Settings',
    ssh: 'SSH tunnel', ssl: 'SSL', advanced: 'Advanced', useSsh: 'Use SSH tunnel', sshHost: 'SSH host', sshPort: 'SSH port',
    sshUser: 'SSH user', sshAuth: 'Authentication', sshPassword: 'SSH password', sshKey: 'Private key file', sshPassphrase: 'Key passphrase',
    sshAgent: 'SSH agent', useSsl: 'Use SSL/TLS', sslVerify: 'Verify server certificate', sslCa: 'CA certificate', sslCert: 'Client certificate',
    sslKey: 'Client key', charset: 'Charset', role: 'Role', wireCrypt: 'Wire encryption', wireCompression: 'Wire compression',
    startupScript: 'Startup script', keepAlive: 'Keep-alive interval (s)', timeout: 'Connection timeout (s)',
    lastConnected: 'Last connected', never: 'never', unsaved: 'Unsaved changes', deleteConfirm: 'Delete session "{{name}}"?',
    passwordPrompt: 'Password for {{name}}', connecting: 'Connecting…', weakStorage: 'No OS keychain found: saved passwords use weak encryption.'
  },
  tree: {
    filter: 'Filter objects', databases: 'Databases', tables: 'Tables', views: 'Views', routines: 'Routines', triggers: 'Triggers',
    materializedViews: 'Materialized views', procedures: 'Procedures', functions: 'Functions', generators: 'Generators',
    events: 'Events', sequences: 'Sequences', domains: 'Domains', exceptions: 'Exceptions', packages: 'Packages', types: 'Types',
    empty: 'No objects', newQuery: 'New query tab', createTable: 'Create table…', createView: 'Create view…', createRoutine: 'Create routine…',
    createDatabase: 'Create database…', drop: 'Drop…', truncate: 'Empty table…', copyName: 'Copy name', showData: 'Show data',
    editStructure: 'Edit structure', showDdl: 'Show CREATE code', exportData: 'Export data…', dropConfirm: 'Drop {{kind}} {{name}}? This cannot be undone.',
    truncateConfirm: 'Delete all rows from {{name}}? This cannot be undone.', renamePrompt: 'New name for {{name}}',
    duplicatePrompt: 'Name of the copy', withData: 'Copy data too'
  },
  kinds: {
    database: 'database', schema: 'schema', table: 'table', view: 'view', materialized_view: 'materialized view', procedure: 'procedure',
    function: 'function', trigger: 'trigger', event: 'event', sequence: 'sequence', domain: 'domain', exception: 'exception',
    package: 'package', type: 'type'
  },
  tabs: { closeOthers: 'Close other tabs', pin: 'Keep open', nextPrev: 'Next / previous tab', host: 'Host', database: 'Database', table: 'Table', data: 'Data', query: 'Query', structure: 'Structure', ddl: 'CREATE code', source: 'Source' },
  host: {
    variables: 'Variables', status: 'Status', processes: 'Processes', commandStats: 'Command statistics', kill: 'Kill process',
    killQuery: 'Kill query', killConfirm: 'Kill process {{id}}?', autoRefresh: 'Auto-refresh'
  },
  database: { objects: '{{count}} objects', size: 'Size', rows: 'Rows', engine: 'Engine', collation: 'Collation', updated: 'Updated', created: 'Created' },
  query: {
    placeholder: '-- Write SQL here. Ctrl+Enter or F9 runs it.', results: 'Result #{{n}}', messages: 'Messages', history: 'History',
    snippets: 'Snippets', noResults: 'Run a query to see results', affected: '{{count}} rows affected', rowsFetched: '{{count}} rows',
    truncated: 'Showing the first {{count}} rows (limit from preferences)', duration: '{{ms}} ms', statements: '{{count}} statements',
    errorAt: 'Error in statement {{n}}', cancelled: 'Cancelled', database: 'Database', saveSnippet: 'Save as snippet…', snippetName: 'Snippet name',
    insertSnippet: 'Insert', clearHistory: 'Clear history', untitled: 'Query', confirmDangerous: 'This script modifies data or schema. Run it?',
    transactionOpen: 'Transaction open', explain: 'Explain'
  },
  data: {
    where: 'WHERE clause, e.g. id > 10', applyFilter: 'Apply', clearFilter: 'Clear', insertRow: 'Insert row', deleteRows: 'Delete selected rows',
    applyChanges: 'Post changes', discardChanges: 'Discard changes', loadMore: 'Load more', loadAll: 'Load all', pending: '{{count}} pending changes',
    total: '{{shown}} of {{total}} rows', noKey: 'This table has no primary or unique key; edits match on all columns.',
    setNull: 'Set NULL', setDefault: 'Set DEFAULT', copyAs: 'Copy as', copyRows: 'Copy rows', copyCell: 'Copy value',
    copyCsv: 'CSV', copyTsv: 'Tab-separated', copySql: 'SQL INSERT', copyMarkdown: 'Markdown', copyJson: 'JSON', editCell: 'Edit value',
    blobEditor: 'Value editor', textMode: 'Text', hexMode: 'Hex', jsonMode: 'JSON', bytes: '{{count}} bytes', readOnly: 'Read-only result'
  },
  structure: {
    columns: 'Columns', indexes: 'Indexes', foreignKeys: 'Foreign keys', checks: 'Check constraints', options: 'Options', partitions: 'Partitions',
    column: 'Column', dataType: 'Data type', length: 'Length/Set', unsigned: 'Unsigned', allowNull: 'Allow NULL', default: 'Default',
    autoIncrement: 'Auto increment', identity: 'Identity', generated: 'Generated / computed', virtual: 'Virtual', stored: 'Stored',
    collation: 'Collation', charset: 'Charset', comment: 'Comment', invisible: 'Invisible', addColumn: 'Add column', removeColumn: 'Remove column',
    addIndex: 'Add index', addForeignKey: 'Add foreign key', addCheck: 'Add check', indexType: 'Index type', indexColumns: 'Columns',
    expression: 'Expression', condition: 'Condition (WHERE)', refTable: 'Reference table', refColumns: 'Reference columns', onUpdate: 'On UPDATE',
    onDelete: 'On DELETE', engine: 'Engine', autoIncValue: 'Auto increment value', rowFormat: 'Row format', tableName: 'Name',
    tableComment: 'Comment', systemVersioning: 'System versioning', tablespace: 'Tablespace', preview: 'SQL preview', noChanges: 'No changes',
    saved: 'Table saved', newTable: 'New table', primary: 'Primary key', unique: 'Unique', index: 'Index', fulltext: 'Full-text', spatial: 'Spatial',
    descending: 'Descending'
  },
  routine: { save: 'Save', saved: 'Saved', run: 'Run' },
  export: {
    title: 'Export grid rows', format: 'Output format', file: 'Output file', includeHeader: 'Include column names', delimiter: 'Field separator',
    quote: 'Enclosure', lineBreak: 'Line break', nullAs: 'NULL as', tableName: 'Table name', sqlMode: 'INSERT mode', rowsPerInsert: 'Rows per INSERT',
    done: 'Exported {{count}} rows to {{file}}', showFile: 'Show file', source: 'Rows', allRows: 'Whole table/query', exporting: 'Exporting…'
  },
  dump: {
    title: 'Export database as SQL', databases: 'Databases', createDatabase: 'Create database', dropDatabase: 'Drop database',
    createTables: 'Create tables', dropTables: 'Drop tables', data: 'Data', dataNone: 'No data', dataInsert: 'INSERT', dataInsertIgnore: 'INSERT IGNORE',
    dataReplace: 'REPLACE', dataDeleteInsert: 'DELETE + INSERT', views: 'Views', routines: 'Routines', triggers: 'Triggers', done: 'Dump finished: {{file}}'
  },
  import: {
    sqlTitle: 'Run SQL file', csvTitle: 'Import CSV file', stopOnError: 'Stop on first error', skipLines: 'Skip first lines',
    targetTable: 'Target table', columnsMap: 'Columns (in file order)', batchSize: 'Rows per INSERT', done: '{{count}} statements executed, {{errors}} errors',
    csvDone: '{{count}} rows imported'
  },
  find: {
    title: 'Find text on server', text: 'Text', databases: 'Databases', caseSensitive: 'Case sensitive', matchType: 'Match', like: 'Contains',
    exact: 'Exact', regexp: 'Regular expression', results: 'Matches', noMatches: 'No matches', count: 'Matching rows', open: 'Open filtered'
  },
  users: {
    title: 'User manager', add: 'Add user', host: 'Host', password: 'Password', privileges: 'Privileges', grants: 'Current grants',
    on: 'On object', grant: 'Grant', revoke: 'Revoke', setPassword: 'Set password', superuser: 'Superuser', canLogin: 'Can log in',
    dropConfirm: 'Drop user {{name}}?'
  },
  settings: {
    title: 'Preferences', general: 'General', editor: 'SQL editor', grid: 'Data grid', ai: 'AI assistant',
    theme: 'Theme', fontSize: 'Font size', fontFamily: 'Font family', maxRows: 'Max rows per query result', pageSize: 'Rows per page (Data tab)',
    nullText: 'NULL display text', autocommit: 'Auto-commit by default', confirmDangerous: 'Confirm before running data-changing scripts',
    restoreTabs: 'Restore query tabs on start', anthropicKey: 'Anthropic API key', openaiKey: 'OpenAI API key', keySaved: 'Key saved',
    keyMissing: 'Not set', defaultProvider: 'Default provider', effort: 'Reasoning effort', low: 'Low', medium: 'Medium',
    high: 'High', maxRowsModel: 'Max rows sent to the model', clearKey: 'Remove key', setKey: 'Save key'
  },
  chat: {
    title: 'AI assistant', placeholder: 'Ask about your database…', send: 'Send', stop: 'Stop', newChat: 'New chat', conversations: 'Conversations',
    noKey: 'Add an API key in Preferences → AI assistant to use the assistant.', thinking: 'Thinking', toolCall: 'Tool: {{name}}',
    approvalTitle: 'The assistant wants to run these statements', approve: 'Run', decline: 'Decline', approved: 'Approved', declined: 'Declined',
    attachEditor: 'Include editor SQL', noSession: 'No connection selected', insertSql: 'Open in editor', runSql: 'Run',
    deleteConversation: 'Delete conversation', empty: 'Ask anything about the connected database: schema, data, query tuning, errors.',
    context: 'Context: {{label}}'
  },
  log: { title: 'SQL log', clear: 'Clear log', copy: 'Copy log' },
  status: {
    connected: 'Connected: {{label}}', notConnected: 'Not connected', rows: '{{count}} rows', selected: '{{count}} selected',
    inTransaction: 'In transaction', autocommitOn: 'Auto-commit on', autocommitOff: 'Auto-commit off'
  },
  errors: {
    connectionLost: 'Connection lost: {{message}}', generic: 'Something went wrong: {{message}}', noSession: 'Open a session first.',
    unsupported: 'Not supported by this server.'
  },
  bulk: {
    title: 'Bulk table editor', menu: 'Bulk table editor…', tables: 'Tables', selectAll: 'Select all', moveTo: 'Move to database',
    moveToSchema: 'Move to schema', engine: 'Change engine', collation: 'Change default collation', convertData: 'Convert existing data (CONVERT TO)',
    rowFormat: 'Change row format', resetAutoIncrement: 'Reset auto increment', tablespace: 'Change tablespace', owner: 'Change owner',
    preview: 'Preview', run: 'Apply to {{count}} tables', done: '{{ok}} tables changed, {{failed}} failed', unsupported: 'Firebird has no bulk table options.',
    keep: '(unchanged)'
  },
  copy: {
    title: 'Copy table', menu: 'Copy table to…', targetSession: 'Target connection', targetDatabase: 'Target database', targetSchema: 'Target schema',
    newName: 'New table name', withData: 'Copy data', dropExisting: 'Drop the target table if it exists', done: 'Copied {{rows}} rows to {{name}}',
    fksDropped: '{{count}} foreign keys were not copied (referenced tables live elsewhere)', progress: '{{rows}} rows copied'
  },
  partitions: {
    title: 'Partitions', none: 'Not partitioned', method: 'Method', expression: 'Partition key', count: 'Number of partitions', add: 'Add partition',
    name: 'Name', bound: 'Values', rows: 'Rows', hintRange: 'e.g. LESS THAN (2025) or LESS THAN MAXVALUE', hintList: 'e.g. IN (1, 2, 3)',
    hintPgRange: "e.g. FROM ('2025-01-01') TO ('2026-01-01')", hintPgList: "e.g. IN ('br', 'pt') or DEFAULT", hintPgHash: 'e.g. WITH (MODULUS 4, REMAINDER 0)',
    pgKeyLocked: 'PostgreSQL cannot change the partition key of an existing table.'
  },
  keys: {
    title: 'Keyboard shortcuts', action: 'Action', shortcut: 'Shortcut', press: 'Press keys…', reset: 'Reset', resetAll: 'Reset all', conflict: 'Already used by "{{action}}"'
  },
  welcome: {
    title: 'Welcome to Open SQL Tool', subtitle: 'Fast SQL client for MySQL, MariaDB, PostgreSQL and Firebird.', open: 'Open session manager'
  }
}

export type Messages = typeof en
