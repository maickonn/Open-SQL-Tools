import type { DbEngine } from '@shared/model'

export interface BuiltinFunction {
  name: string
  params: string[]
  /** One-line description shown in completion, hover and signature help. */
  description: string
}

const words = (s: string): string[] => s.trim().split(/\s+/)

const COMMON_KEYWORDS = words(`
  SELECT FROM WHERE AND OR NOT NULL IS IN EXISTS BETWEEN LIKE AS ON JOIN LEFT RIGHT INNER OUTER FULL CROSS NATURAL USING GROUP BY ORDER
  HAVING ASC DESC UNION ALL DISTINCT INSERT INTO VALUES UPDATE SET DELETE CREATE ALTER DROP TABLE VIEW INDEX UNIQUE PRIMARY KEY FOREIGN
  REFERENCES CONSTRAINT CHECK DEFAULT CASCADE CASE WHEN THEN ELSE END WITH RECURSIVE PROCEDURE FUNCTION TRIGGER COMMIT ROLLBACK
  GRANT REVOKE TRUE FALSE ADD COLUMN RENAME TO EXCEPT INTERSECT`)

const KEYWORDS: Record<'mysql' | 'postgres' | 'firebird' | 'sqlite', string[]> = {
  mysql: words(`
    LIMIT OFFSET REPLACE IGNORE DUPLICATE STRAIGHT_JOIN SQL_CALC_FOUND_ROWS HIGH_PRIORITY LOW_PRIORITY DATABASE SCHEMA SHOW TABLES COLUMNS
    DATABASES PROCESSLIST VARIABLES STATUS DESCRIBE EXPLAIN ANALYZE USE TRUNCATE TEMPORARY IF ENGINE CHARSET COLLATE AUTO_INCREMENT
    UNSIGNED ZEROFILL PARTITION EVENT SCHEDULE EVERY CALL DECLARE BEGIN LOOP WHILE REPEAT UNTIL LEAVE ITERATE RETURN DELIMITER HANDLER
    CURSOR FETCH OPEN CLOSE START TRANSACTION LOCK UNLOCK FOR SHARE MODE OVER WINDOW ROWS RANGE PRECEDING FOLLOWING CURRENT ROW
    REGEXP RLIKE DIV MOD XOR INTERVAL SEQUENCE RETURNING`),
  postgres: words(`
    LIMIT OFFSET FETCH FIRST NEXT ROWS ONLY RETURNING ILIKE SIMILAR ON CONFLICT DO NOTHING SCHEMA SEQUENCE MATERIALIZED REFRESH
    EXPLAIN ANALYZE VERBOSE VACUUM TRUNCATE TEMPORARY IF LATERAL TABLESAMPLE OVER WINDOW PARTITION RANGE GROUPS PRECEDING FOLLOWING
    CURRENT ROW FILTER WITHIN BEGIN START TRANSACTION SAVEPOINT RELEASE LOCK SHARE NOWAIT SKIP LOCKED DOMAIN TYPE EXTENSION LANGUAGE
    RETURNS DECLARE PERFORM RAISE NOTICE EXCEPTION LOOP FOREACH COPY INHERITS OWNER ROLE USER IDENTITY GENERATED ALWAYS STORED
    COMMENT IS INTERVAL ANY SOME ARRAY`),
  firebird: words(`
    FIRST SKIP ROWS FETCH NEXT ONLY OFFSET RETURNING RECREATE GENERATOR SEQUENCE EXCEPTION DOMAIN PACKAGE BODY BLOCK EXECUTE
    STATEMENT SUSPEND DECLARE VARIABLE BEGIN RETURNS FOR DO WHILE LEAVE BREAK EXIT IF POSITION ACTIVE INACTIVE BEFORE AFTER
    COMPUTED CONTAINING STARTING WITH PLAN MERGE MATCHED UPDATE OR INSERT MATCHING GLOBAL TEMPORARY PRESERVE CURRENT_CONNECTION
    CURRENT_TRANSACTION GEN_ID NEXT VALUE TERM AUTONOMOUS TRANSACTION SNAPSHOT COMMITTED WAIT NO LOCK TIMEOUT OVER WINDOW
    PARTITION RANGE IDENTITY GENERATED ALWAYS BOOLEAN SIMILAR ESCAPE COLLATE CHARACTER`),
  sqlite: words(`
    LIMIT OFFSET RETURNING GLOB REGEXP MATCH ESCAPE PRAGMA ATTACH DETACH VACUUM ANALYZE REINDEX EXPLAIN QUERY PLAN TEMP TEMPORARY
    IF WITHOUT ROWID STRICT AUTOINCREMENT CONFLICT ABORT FAIL IGNORE REPLACE UPSERT DO NOTHING BEGIN DEFERRED IMMEDIATE EXCLUSIVE
    TRANSACTION SAVEPOINT RELEASE OVER WINDOW PARTITION RANGE GROUPS ROWS PRECEDING FOLLOWING CURRENT ROW FILTER INDEXED COLLATE
    VIRTUAL GENERATED ALWAYS STORED`)
}

/** `NAME(param, …)|description` entries. */
const fn = (spec: string): BuiltinFunction[] =>
  spec
    .trim()
    .split('\n')
    .map((line) => {
      const [sig, description] = line.trim().split('|')
      const open = sig.indexOf('(')
      const inner = sig.slice(open + 1, sig.lastIndexOf(')')).trim()
      return { name: sig.slice(0, open), params: inner ? inner.split(/,\s*/) : [], description: description ?? '' }
    })

const COMMON_FUNCTIONS = fn(`
  COUNT(expression)|Number of rows, or of non-null values of the expression
  SUM(expression)|Sum of the values
  AVG(expression)|Average of the values
  MIN(expression)|Smallest value
  MAX(expression)|Largest value
  COALESCE(value, ...)|First argument that is not NULL
  NULLIF(value1, value2)|NULL when both values are equal, otherwise the first one
  CAST(expression AS type)|Converts the expression to another type
  UPPER(string)|Converts to upper case
  LOWER(string)|Converts to lower case
  TRIM(string)|Removes leading and trailing spaces
  ABS(number)|Absolute value
  ROUND(number, decimals)|Rounds to the given number of decimals
  ROW_NUMBER()|Sequential number of the row within its window partition
  RANK()|Rank of the row within its partition, with gaps
  DENSE_RANK()|Rank of the row within its partition, without gaps
  LAG(expression, offset, default)|Value from a previous row of the partition
  LEAD(expression, offset, default)|Value from a following row of the partition`)

const FUNCTIONS: Record<'mysql' | 'postgres' | 'firebird' | 'sqlite', BuiltinFunction[]> = {
  mysql: fn(`
    CONCAT(str1, str2, ...)|Concatenates strings (NULL if any argument is NULL)
    CONCAT_WS(separator, str1, str2, ...)|Concatenates strings with a separator, skipping NULLs
    IFNULL(expression, alternative)|The alternative when the expression is NULL
    IF(condition, then, else)|Returns then or else depending on the condition
    SUBSTRING(str, pos, len)|Part of a string (positions start at 1)
    LENGTH(str)|Length in bytes
    CHAR_LENGTH(str)|Length in characters
    REPLACE(str, from_str, to_str)|Replaces every occurrence of a substring
    LEFT(str, len)|Leftmost characters
    RIGHT(str, len)|Rightmost characters
    LPAD(str, len, padstr)|Pads on the left to the given length
    RPAD(str, len, padstr)|Pads on the right to the given length
    INSTR(str, substr)|Position of the first occurrence of a substring
    LOCATE(substr, str, pos)|Position of a substring, searching from pos
    GROUP_CONCAT(expression ORDER BY … SEPARATOR sep)|Concatenates the group's values
    NOW()|Current date and time
    CURDATE()|Current date
    CURTIME()|Current time
    DATE(expression)|Date part of a date/time
    DATE_FORMAT(date, format)|Formats a date (e.g. '%Y-%m-%d')
    STR_TO_DATE(str, format)|Parses a string into a date
    DATE_ADD(date, INTERVAL expr unit)|Adds an interval to a date
    DATE_SUB(date, INTERVAL expr unit)|Subtracts an interval from a date
    DATEDIFF(date1, date2)|Days between two dates
    TIMESTAMPDIFF(unit, start, end)|Difference between two date/times in the given unit
    YEAR(date)|Year of a date
    MONTH(date)|Month of a date
    DAY(date)|Day of the month
    FLOOR(number)|Largest integer not greater than the number
    CEIL(number)|Smallest integer not less than the number
    MOD(n, m)|Remainder of n divided by m
    FORMAT(number, decimals)|Formats a number with thousands separators
    JSON_EXTRACT(json_doc, path, ...)|Value at a JSON path
    JSON_OBJECT(key, value, ...)|Builds a JSON object
    JSON_ARRAYAGG(expression)|Aggregates values into a JSON array
    UUID()|New UUID string
    LAST_INSERT_ID()|Last AUTO_INCREMENT value generated on this connection
    FOUND_ROWS()|Rows the previous SELECT would have returned without LIMIT`),
  postgres: fn(`
    CONCAT(str1, str2, ...)|Concatenates the text of the arguments, ignoring NULLs
    CONCAT_WS(separator, str1, str2, ...)|Concatenates with a separator, ignoring NULLs
    SUBSTRING(string FROM start FOR count)|Part of a string
    LENGTH(string)|Number of characters
    REPLACE(string, from, to)|Replaces every occurrence of a substring
    LEFT(string, n)|First n characters
    RIGHT(string, n)|Last n characters
    LPAD(string, length, fill)|Pads on the left to the given length
    RPAD(string, length, fill)|Pads on the right to the given length
    POSITION(substring IN string)|Position of a substring
    SPLIT_PART(string, delimiter, n)|n-th field of a delimited string
    STRING_AGG(expression, delimiter)|Concatenates the group's values with a delimiter
    ARRAY_AGG(expression)|Aggregates values into an array
    REGEXP_REPLACE(source, pattern, replacement, flags)|Replaces matches of a regular expression
    NOW()|Current date and time (start of the transaction)
    CURRENT_DATE()|Current date
    DATE_TRUNC(field, source)|Truncates a timestamp to the given precision
    EXTRACT(field FROM source)|A field (year, month, epoch…) of a date/time
    AGE(timestamp, timestamp)|Interval between two timestamps
    TO_CHAR(value, format)|Formats a date or number as text
    TO_DATE(text, format)|Parses text into a date
    TO_TIMESTAMP(text, format)|Parses text into a timestamp
    GENERATE_SERIES(start, stop, step)|Set of values from start to stop
    FLOOR(number)|Largest integer not greater than the number
    CEIL(number)|Smallest integer not less than the number
    MOD(y, x)|Remainder of y / x
    GREATEST(value, ...)|Largest of the values
    LEAST(value, ...)|Smallest of the values
    JSONB_BUILD_OBJECT(key, value, ...)|Builds a jsonb object
    JSONB_AGG(expression)|Aggregates values into a jsonb array
    JSONB_EXTRACT_PATH_TEXT(from_json, path, ...)|Text at a JSON path
    GEN_RANDOM_UUID()|New random UUID
    NEXTVAL(sequence)|Advances a sequence and returns its new value
    CURRVAL(sequence)|Last value returned by nextval for the sequence in this session
    PG_SIZE_PRETTY(bytes)|Human-readable size
    PG_TOTAL_RELATION_SIZE(relation)|Disk space used by a table with indexes and TOAST`),
  firebird: fn(`
    SUBSTRING(str FROM start FOR length)|Part of a string (positions start at 1)
    CHAR_LENGTH(str)|Length in characters
    OCTET_LENGTH(str)|Length in bytes
    POSITION(substr IN str)|Position of a substring
    REPLACE(str, find, repl)|Replaces every occurrence of a substring
    LEFT(str, length)|Leftmost characters
    RIGHT(str, length)|Rightmost characters
    LPAD(str, length, padstr)|Pads on the left to the given length
    RPAD(str, length, padstr)|Pads on the right to the given length
    LIST(expression, separator)|Concatenates the group's values with a separator
    IIF(condition, then, else)|Returns then or else depending on the condition
    DECODE(expression, value, result, ..., default)|Result for the first value equal to the expression
    EXTRACT(part FROM datetime)|A part (YEAR, MONTH, WEEKDAY…) of a date/time
    DATEADD(amount unit TO datetime)|Adds an amount of a unit to a date/time
    DATEDIFF(unit FROM start TO end)|Difference between two date/times in the given unit
    CURRENT_DATE()|Current date
    CURRENT_TIMESTAMP()|Current date and time
    GEN_ID(generator, step)|Advances a generator by step and returns the new value
    FLOOR(number)|Largest integer not greater than the number
    CEILING(number)|Smallest integer not less than the number
    MOD(a, b)|Remainder of a divided by b
    TRUNC(number, scale)|Truncates a number
    MAXVALUE(value, ...)|Largest of the values
    MINVALUE(value, ...)|Smallest of the values
    HASH(value)|Hash of a value
    UUID_TO_CHAR(uuid)|Formats a binary UUID as text
    GEN_UUID()|New random UUID (binary)
    RDB$GET_CONTEXT(namespace, variable)|Value of a context variable (SYSTEM, USER_SESSION, USER_TRANSACTION)
    RDB$SET_CONTEXT(namespace, variable, value)|Sets a USER_SESSION or USER_TRANSACTION context variable`),
  sqlite: fn(`
    IFNULL(x, y)|y when x is NULL
    IIF(condition, then, else)|Returns then or else depending on the condition
    SUBSTR(string, start, length)|Part of a string (positions start at 1)
    LENGTH(value)|Characters in a string or bytes in a blob
    REPLACE(string, find, replacement)|Replaces every occurrence of a substring
    INSTR(string, substring)|Position of the first occurrence of a substring
    PRINTF(format, ...)|Formats values like C printf
    GROUP_CONCAT(expression, separator)|Concatenates the group's values
    DATE(time_value, modifier, ...)|Date as YYYY-MM-DD
    TIME(time_value, modifier, ...)|Time as HH:MM:SS
    DATETIME(time_value, modifier, ...)|Date and time as YYYY-MM-DD HH:MM:SS
    JULIANDAY(time_value, modifier, ...)|Julian day number
    STRFTIME(format, time_value, modifier, ...)|Formats a date/time
    TYPEOF(value)|Storage class of the value (null, integer, real, text, blob)
    RANDOM()|Pseudo-random 64-bit integer
    HEX(value)|Hexadecimal text of a value
    JSON_EXTRACT(json, path, ...)|Value at a JSON path
    JSON_OBJECT(label, value, ...)|Builds a JSON object
    JSON_GROUP_ARRAY(value)|Aggregates values into a JSON array
    LAST_INSERT_ROWID()|ROWID of the last inserted row on this connection
    CHANGES()|Rows changed by the last statement
    TOTAL(expression)|Sum as a floating-point value (0.0 when there are no rows)`)
}

const family = (engine: DbEngine): 'mysql' | 'postgres' | 'firebird' | 'sqlite' => (engine === 'mariadb' ? 'mysql' : engine)

export function keywordsFor(engine: DbEngine): string[] {
  return [...new Set([...COMMON_KEYWORDS, ...KEYWORDS[family(engine)]])]
}

const functionCache = new Map<string, Map<string, BuiltinFunction>>()

/** Built-in functions of the engine, keyed by upper-case name. */
export function functionsFor(engine: DbEngine): Map<string, BuiltinFunction> {
  const key = family(engine)
  let map = functionCache.get(key)
  if (!map) {
    map = new Map()
    for (const f of [...COMMON_FUNCTIONS, ...FUNCTIONS[key]]) map.set(f.name.toUpperCase(), f)
    functionCache.set(key, map)
  }
  return map
}
