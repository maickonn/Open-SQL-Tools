import type {
  CellValue,
  CheckDef,
  ColumnDef,
  DbObjectInfo,
  DbObjectRef,
  ExceptionInfo,
  FkAction,
  ForeignKeyDef,
  IndexDef,
  ObjectDependency,
  ObjectKind,
  SequenceInfo,
  ServerUser,
  TriggerDatabaseEvent,
  TriggerDef,
  TriggerEvent,
  TableStructure,
  UserPrivileges
} from '@shared/model'
import type { CatalogColumn, CatalogRoutine } from '@shared/model'
import type { SchemaInspector } from '@domain/ports/database'
import type { CollationInfo, HostInfo } from '@shared/workerApi'
import { groupBy, keyValueResult, num, optStr, queryObjects, str, type QueryFn, type Row } from '../common/queryHelpers'
import type { FbDialect } from './fbDialect'

const V3 = 30000
const V4 = 40000
const V5 = 50000

/** Decodes RDB$FIELDS type columns into SQL type text. */
export function fbTypeName(r: Row): { base: string; full: string } {
  const type = num(r.f_type) ?? 0
  const sub = num(r.f_sub_type) ?? 0
  const scale = -(num(r.f_scale) ?? 0)
  const precision = num(r.f_precision) ?? 0
  const charLen = num(r.f_char_len) ?? num(r.f_length) ?? 0
  const charset = optStr(r.charset)
  const numeric = (fallback: string): { base: string; full: string } => {
    if (sub === 1 || sub === 2 || scale > 0) {
      const kw = sub === 2 ? 'DECIMAL' : 'NUMERIC'
      const p = precision || (type === 7 ? 4 : type === 8 ? 9 : type === 26 ? 38 : 18)
      return { base: kw, full: `${kw}(${p},${scale})` }
    }
    return { base: fallback, full: fallback }
  }
  switch (type) {
    case 7: return numeric('SMALLINT')
    case 8: return numeric('INTEGER')
    case 16: return numeric('BIGINT')
    case 26: return numeric('INT128')
    case 10: return { base: 'FLOAT', full: 'FLOAT' }
    case 27: return scale > 0 ? numeric('DOUBLE PRECISION') : { base: 'DOUBLE PRECISION', full: 'DOUBLE PRECISION' }
    case 12: return { base: 'DATE', full: 'DATE' }
    case 13: return { base: 'TIME', full: 'TIME' }
    case 35: return { base: 'TIMESTAMP', full: 'TIMESTAMP' }
    case 28: return { base: 'TIME WITH TIME ZONE', full: 'TIME WITH TIME ZONE' }
    case 29: return { base: 'TIMESTAMP WITH TIME ZONE', full: 'TIMESTAMP WITH TIME ZONE' }
    case 23: return { base: 'BOOLEAN', full: 'BOOLEAN' }
    case 24: return { base: 'DECFLOAT', full: 'DECFLOAT(16)' }
    case 25: return { base: 'DECFLOAT', full: 'DECFLOAT(34)' }
    case 14: return { base: 'CHAR', full: `CHAR(${charLen})${charset === 'OCTETS' ? ' CHARACTER SET OCTETS' : ''}` }
    case 37: return { base: 'VARCHAR', full: `VARCHAR(${charLen})${charset === 'OCTETS' ? ' CHARACTER SET OCTETS' : ''}` }
    case 261: {
      const seg = num(r.f_segment)
      const subName = sub === 1 ? 'TEXT' : sub === 0 ? 'BINARY' : String(sub)
      return { base: 'BLOB', full: `BLOB SUB_TYPE ${subName}${seg && seg !== 80 ? ` SEGMENT SIZE ${seg}` : ''}` }
    }
    default: return { base: `TYPE_${type}`, full: `TYPE_${type}` }
  }
}

/** RDB$DEPENDENCIES object type codes. */
const FB_DEPENDENCY_TYPES: Partial<Record<ObjectKind, number>> = {
  table: 0, view: 1, trigger: 2, procedure: 5, exception: 7, domain: 9, sequence: 14, function: 15, package: 18
}
const FB_DEPENDENCY_KINDS: Record<number, ObjectKind> = {
  0: 'table', 1: 'view', 2: 'trigger', 5: 'procedure', 7: 'exception', 9: 'domain', 14: 'sequence', 15: 'function', 18: 'package', 19: 'package'
}

/**
 * Descriptions as inline text: text BLOBs cost three extra round trips each (open, read, close),
 * which over SSH/WAN turns a catalog listing into minutes. Only for display (tooltips, grids).
 */
const DESCR = 'CAST(SUBSTRING(RDB$DESCRIPTION FROM 1 FOR 1000) AS VARCHAR(1000))'

const stripDefault = (src: string | undefined): string | null => (src ? src.replace(/^\s*DEFAULT\s+/i, '').trim() : null)

const fkRule = (v: CellValue): FkAction => {
  const s = str(v).toUpperCase()
  return (['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'].includes(s) ? s : 'NO ACTION') as FkAction
}

export class FbInspector implements SchemaInspector {
  constructor(
    private readonly query: QueryFn,
    private readonly dialect: FbDialect,
    private readonly version: number
  ) {}

  private lit(v: string): string {
    return this.dialect.quoteString(v)
  }

  async listDatabases(): Promise<string[]> {
    return []
  }

  async listSchemas(): Promise<string[]> {
    if (this.version < 60000) return []
    const rows = await queryObjects(this.query, 'SELECT TRIM(RDB$SCHEMA_NAME) AS N FROM RDB$SCHEMAS ORDER BY 1')
    return rows.map((r) => str(r.n))
  }

  async listObjects(): Promise<DbObjectInfo[]> {
    const pkgFilter = this.version >= V3 ? ' AND RDB$PACKAGE_NAME IS NULL' : ''
    const user = 'COALESCE(RDB$SYSTEM_FLAG, 0) = 0'
    // Every kind in one round trip (catalog browsing is latency-bound over SSH/WAN).
    const parts = [
      `SELECT CAST(CASE WHEN RDB$VIEW_BLR IS NULL THEN 'table' ELSE 'view' END AS VARCHAR(16)) AS OBJ_KIND, TRIM(RDB$RELATION_NAME) AS NAME,
              CAST(NULL AS VARCHAR(63)) AS REL, ${DESCR} AS DESCR, 0 AS INACTIVE FROM RDB$RELATIONS WHERE ${user}`,
      `SELECT 'procedure', TRIM(RDB$PROCEDURE_NAME), NULL, ${DESCR}, 0 FROM RDB$PROCEDURES WHERE ${user}${pkgFilter}`,
      `SELECT 'function', TRIM(RDB$FUNCTION_NAME), NULL, ${DESCR}, 0 FROM RDB$FUNCTIONS WHERE ${user}${pkgFilter}`,
      `SELECT 'trigger', TRIM(RDB$TRIGGER_NAME), TRIM(RDB$RELATION_NAME), ${DESCR}, COALESCE(RDB$TRIGGER_INACTIVE, 0) FROM RDB$TRIGGERS WHERE ${user}`,
      `SELECT 'sequence', TRIM(RDB$GENERATOR_NAME), NULL, ${DESCR}, 0 FROM RDB$GENERATORS WHERE ${user}`,
      `SELECT 'domain', TRIM(RDB$FIELD_NAME), NULL, ${DESCR}, 0 FROM RDB$FIELDS WHERE ${user} AND RDB$FIELD_NAME NOT STARTING WITH 'RDB$'`,
      `SELECT 'exception', TRIM(RDB$EXCEPTION_NAME), NULL, ${DESCR}, 0 FROM RDB$EXCEPTIONS WHERE ${user}`
    ]
    if (this.version >= V3) parts.push(`SELECT 'package', TRIM(RDB$PACKAGE_NAME), NULL, ${DESCR}, 0 FROM RDB$PACKAGES WHERE ${user}`)
    const rows = await queryObjects(this.query, `${parts.join('\nUNION ALL\n')}\nORDER BY 2`)
    return rows.map((r) => {
      const kind = str(r.obj_kind) as DbObjectInfo['kind']
      return {
        name: str(r.name),
        kind,
        table: kind === 'trigger' ? optStr(r.rel) : undefined,
        comment: optStr(r.descr),
        inactive: kind === 'trigger' && num(r.inactive) === 1 ? true : undefined
      }
    })
  }

  async listSequences(): Promise<SequenceInfo[]> {
    const increment = this.version >= V3 ? 'RDB$GENERATOR_INCREMENT' : '1'
    const gens = await queryObjects(
      this.query,
      `SELECT TRIM(RDB$GENERATOR_NAME) AS NAME, ${increment} AS INC, ${DESCR} AS DESCR
         FROM RDB$GENERATORS WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0 ORDER BY 1`
    )
    // Current values: one GEN_ID per generator, batched into UNION ALL queries (each branch is two of the 255 contexts allowed).
    const values = new Map<string, string>()
    for (let i = 0; i < gens.length; i += 100) {
      const batch = gens.slice(i, i + 100)
      const sql = batch
        .map((g) => `SELECT CAST(${this.lit(str(g.name))} AS VARCHAR(63)) AS NAME, GEN_ID(${this.dialect.quoteIdent(str(g.name))}, 0) AS VAL FROM RDB$DATABASE`)
        .join('\nUNION ALL\n')
      for (const r of await queryObjects(this.query, sql)) values.set(str(r.name), str(r.val))
    }
    return gens.map((g) => ({ name: str(g.name), value: values.get(str(g.name)) ?? '', increment: num(g.inc), comment: optStr(g.descr) }))
  }

  async listExceptions(): Promise<ExceptionInfo[]> {
    const rows = await queryObjects(
      this.query,
      `SELECT RDB$EXCEPTION_NUMBER AS NUM, TRIM(RDB$EXCEPTION_NAME) AS NAME, RDB$MESSAGE AS MSG, ${DESCR} AS DESCR
         FROM RDB$EXCEPTIONS WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0 ORDER BY 2`
    )
    return rows.map((r) => ({ number: num(r.num) ?? 0, name: str(r.name), message: str(r.msg), comment: optStr(r.descr) }))
  }

  /** RDB$DEPENDENCIES in both directions; check-constraint triggers are reported under their table. */
  async getDependencies(ref: DbObjectRef): Promise<ObjectDependency[]> {
    const own = FB_DEPENDENCY_TYPES[ref.kind]
    if (own === undefined) return []
    const name = this.lit(ref.name)
    // Relations are recorded as type 0 when depended on, views as type 1 when depending.
    const asDependent = ref.kind === 'view' ? '1' : ref.kind === 'table' ? '0' : String(own)
    const asDependedOn = ref.kind === 'view' || ref.kind === 'table' ? '0' : String(own)
    const notCheck = (col: string): string => `NOT EXISTS (SELECT 1 FROM RDB$CHECK_CONSTRAINTS C WHERE C.RDB$TRIGGER_NAME = ${col})`
    const kindOf = (nameCol: string, typeCol: string): string =>
      `CASE WHEN ${typeCol} = 0 AND EXISTS (SELECT 1 FROM RDB$RELATIONS R WHERE R.RDB$RELATION_NAME = ${nameCol} AND R.RDB$VIEW_BLR IS NOT NULL) THEN 1 ELSE ${typeCol} END`
    const rows = await queryObjects(
      this.query,
      `SELECT CAST('uses' AS VARCHAR(8)) AS DIR, TRIM(D.RDB$DEPENDED_ON_NAME) AS NAME, ${kindOf('D.RDB$DEPENDED_ON_NAME', 'D.RDB$DEPENDED_ON_TYPE')} AS DTYPE,
              TRIM(D.RDB$FIELD_NAME) AS FIELD
         FROM RDB$DEPENDENCIES D
        WHERE D.RDB$DEPENDENT_NAME = ${name} AND D.RDB$DEPENDENT_TYPE = ${asDependent}
       UNION ALL
       SELECT 'usedBy', TRIM(D.RDB$DEPENDENT_NAME), ${kindOf('D.RDB$DEPENDENT_NAME', 'D.RDB$DEPENDENT_TYPE')}, TRIM(D.RDB$FIELD_NAME)
         FROM RDB$DEPENDENCIES D
        WHERE D.RDB$DEPENDED_ON_NAME = ${name} AND D.RDB$DEPENDED_ON_TYPE = ${asDependedOn} AND ${notCheck('D.RDB$DEPENDENT_NAME')}`
    )
    const out = new Map<string, ObjectDependency>()
    for (const r of rows) {
      const kind = FB_DEPENDENCY_KINDS[num(r.dtype) ?? -1]
      const depName = str(r.name)
      if (!kind || depName.startsWith('RDB$') || (depName === ref.name && kind === ref.kind)) continue
      const direction = str(r.dir) as ObjectDependency['direction']
      const key = `${direction}|${kind}|${depName}`
      const entry = out.get(key) ?? { direction, kind, name: depName, fields: [] }
      const field = optStr(r.field)
      if (field && !entry.fields!.includes(field)) entry.fields!.push(field)
      out.set(key, entry)
    }
    return [...out.values()].map((d) => (d.fields?.length ? d : { ...d, fields: undefined }))
  }

  async getTrigger(ref: DbObjectRef): Promise<TriggerDef> {
    const r = await queryObjects(
      this.query,
      `SELECT TRIM(RDB$RELATION_NAME) AS REL, RDB$TRIGGER_TYPE AS TTYPE, RDB$TRIGGER_SEQUENCE AS SEQ, RDB$TRIGGER_INACTIVE AS INACTIVE,
              RDB$TRIGGER_SOURCE AS SRC FROM RDB$TRIGGERS WHERE RDB$TRIGGER_NAME = ${this.lit(ref.name)}`
    )
    const t = r[0]
    if (!t) throw new Error(`Trigger not found: ${ref.name}`)
    const parts = decodeTriggerParts(num(t.ttype) ?? 0)
    const source = optStr(t.src)
    return {
      name: ref.name,
      table: optStr(t.rel),
      timing: parts.timing,
      events: parts.events,
      databaseEvent: parts.databaseEvent,
      position: num(t.seq) ?? 0,
      active: num(t.inactive) !== 1,
      body: (source ?? '').trim(),
      editable: !parts.ddl && source !== undefined,
      note: parts.ddl ? 'DDL triggers can be edited in the Source tab.' : source === undefined ? 'The trigger source is not stored in the database.' : undefined
    }
  }

  /** EXECUTE PROCEDURE / SELECT … FROM for procedures, SELECT f(…) FROM RDB$DATABASE for functions. */
  async getRoutineCall(ref: DbObjectRef): Promise<string> {
    const q = this.dialect.quoteIdent(ref.name)
    const arg = (p: Row): string => `NULL /* ${str(p.pname) || 'ARG'} ${this.paramType(p)} */`
    if (ref.kind === 'procedure') {
      const params = await this.parameters('RDB$PROCEDURE_PARAMETERS', 'RDB$PROCEDURE_NAME', ref.name)
      const inputs = params.filter((p) => num(p.ptype) === 0)
      const outputs = params.filter((p) => num(p.ptype) === 1)
      const typeRow = await queryObjects(
        this.query,
        `SELECT RDB$PROCEDURE_TYPE AS PTYPE FROM RDB$PROCEDURES WHERE RDB$PROCEDURE_NAME = ${this.lit(ref.name)}${this.version >= V3 ? ' AND RDB$PACKAGE_NAME IS NULL' : ''}`
      )
      // 1 = selectable (uses SUSPEND), 2 = executable; older databases leave it NULL.
      const selectable = (num(typeRow[0]?.ptype) ?? (outputs.length ? 1 : 2)) === 1
      const args = inputs.length ? `(${inputs.map(arg).join(', ')})` : ''
      return selectable ? `SELECT * FROM ${q}${args};` : `EXECUTE PROCEDURE ${q}${args};`
    }
    if (ref.kind === 'function') {
      if (this.version < V3) return `SELECT ${q}() FROM RDB$DATABASE;`
      const r = await queryObjects(this.query, `SELECT RDB$RETURN_ARGUMENT AS RETARG FROM RDB$FUNCTIONS WHERE RDB$FUNCTION_NAME = ${this.lit(ref.name)} AND RDB$PACKAGE_NAME IS NULL`)
      const retPos = num(r[0]?.retarg) ?? 0
      const args = await queryObjects(
        this.query,
        `SELECT TRIM(A.RDB$ARGUMENT_NAME) AS PNAME, A.RDB$ARGUMENT_POSITION AS POS, TRIM(A.RDB$FIELD_SOURCE) AS SRC, ${this.fieldColumns('F')}
           FROM RDB$FUNCTION_ARGUMENTS A JOIN RDB$FIELDS F ON F.RDB$FIELD_NAME = A.RDB$FIELD_SOURCE
          WHERE A.RDB$FUNCTION_NAME = ${this.lit(ref.name)} AND A.RDB$PACKAGE_NAME IS NULL ORDER BY A.RDB$ARGUMENT_POSITION`
      )
      return `SELECT ${q}(${args.filter((a) => num(a.pos) !== retPos).map(arg).join(', ')}) FROM RDB$DATABASE;`
    }
    throw new Error(`${ref.kind} objects cannot be executed`)
  }

  private fieldColumns(prefix: string): string {
    // Aliases avoid reserved words such as CHARACTER_LENGTH.
    return `${prefix}.RDB$FIELD_TYPE AS F_TYPE, ${prefix}.RDB$FIELD_SUB_TYPE AS F_SUB_TYPE, ${prefix}.RDB$FIELD_SCALE AS F_SCALE,
            ${prefix}.RDB$FIELD_PRECISION AS F_PRECISION, ${prefix}.RDB$CHARACTER_LENGTH AS F_CHAR_LEN,
            ${prefix}.RDB$FIELD_LENGTH AS F_LENGTH, ${prefix}.RDB$SEGMENT_LENGTH AS F_SEGMENT`
  }

  async listColumns(): Promise<CatalogColumn[]> {
    // Descriptions are BLOBs (one extra round trip per value): left out of the batch.
    const rows = await queryObjects(
      this.query,
      `SELECT TRIM(RF.RDB$RELATION_NAME) AS TBL, TRIM(RF.RDB$FIELD_NAME) AS NAME, ${this.fieldColumns('F')},
              COALESCE(RF.RDB$NULL_FLAG, F.RDB$NULL_FLAG, 0) AS NN,
              (SELECT COUNT(*) FROM RDB$RELATION_CONSTRAINTS RC
                 JOIN RDB$INDEX_SEGMENTS S ON S.RDB$INDEX_NAME = RC.RDB$INDEX_NAME
                WHERE RC.RDB$RELATION_NAME = RF.RDB$RELATION_NAME AND RC.RDB$CONSTRAINT_TYPE = 'PRIMARY KEY'
                  AND S.RDB$FIELD_NAME = RF.RDB$FIELD_NAME) AS PK
         FROM RDB$RELATION_FIELDS RF
         JOIN RDB$FIELDS F ON F.RDB$FIELD_NAME = RF.RDB$FIELD_SOURCE
         JOIN RDB$RELATIONS R ON R.RDB$RELATION_NAME = RF.RDB$RELATION_NAME
        WHERE COALESCE(R.RDB$SYSTEM_FLAG, 0) = 0
        ORDER BY RF.RDB$RELATION_NAME, RF.RDB$FIELD_POSITION`
    )
    return rows.map((r) => ({ table: str(r.tbl), name: str(r.name), type: fbTypeName(r).full, nullable: num(r.nn) !== 1, primaryKey: (num(r.pk) ?? 0) > 0 }))
  }

  async listRoutines(): Promise<CatalogRoutine[]> {
    // Procedures, plus PSQL functions on 3+ (not UDFs), with their parameters in one query.
    // RET marks a function's return argument; PTYPE 1 is a procedure output parameter.
    const v3 = this.version >= V3
    const functions = v3
      ? `UNION ALL
         SELECT TRIM(FN.RDB$FUNCTION_NAME), 'function', TRIM(A.RDB$ARGUMENT_NAME), 0, A.RDB$ARGUMENT_POSITION,
                CASE WHEN A.RDB$ARGUMENT_POSITION = FN.RDB$RETURN_ARGUMENT THEN 1 ELSE 0 END, TRIM(A.RDB$FIELD_SOURCE), ${this.fieldColumns('F')}
           FROM RDB$FUNCTIONS FN
           LEFT JOIN RDB$FUNCTION_ARGUMENTS A ON A.RDB$FUNCTION_NAME = FN.RDB$FUNCTION_NAME AND A.RDB$PACKAGE_NAME IS NULL
           LEFT JOIN RDB$FIELDS F ON F.RDB$FIELD_NAME = A.RDB$FIELD_SOURCE
          WHERE COALESCE(FN.RDB$SYSTEM_FLAG, 0) = 0 AND FN.RDB$MODULE_NAME IS NULL AND FN.RDB$PACKAGE_NAME IS NULL`
      : ''
    const rows = await queryObjects(
      this.query,
      `SELECT * FROM (
         SELECT TRIM(P.RDB$PROCEDURE_NAME) AS NAME, CAST('procedure' AS VARCHAR(9)) AS KIND, TRIM(PP.RDB$PARAMETER_NAME) AS PNAME,
                PP.RDB$PARAMETER_TYPE AS PTYPE, PP.RDB$PARAMETER_NUMBER AS POS, 0 AS RET, TRIM(PP.RDB$FIELD_SOURCE) AS SRC, ${this.fieldColumns('F')}
           FROM RDB$PROCEDURES P
           LEFT JOIN RDB$PROCEDURE_PARAMETERS PP ON PP.RDB$PROCEDURE_NAME = P.RDB$PROCEDURE_NAME${v3 ? ' AND PP.RDB$PACKAGE_NAME IS NULL' : ''}
           LEFT JOIN RDB$FIELDS F ON F.RDB$FIELD_NAME = PP.RDB$FIELD_SOURCE
          WHERE COALESCE(P.RDB$SYSTEM_FLAG, 0) = 0${v3 ? ' AND P.RDB$PACKAGE_NAME IS NULL' : ''}
         ${functions}
       ) R
       ORDER BY NAME, PTYPE, POS`
    )
    return [...groupBy(rows, (r) => `${str(r.kind)}:${str(r.name)}`).values()].map((group) => {
      const r = group[0]
      const args = group.filter((p) => optStr(p.src))
      const ret = args.find((p) => num(p.ret) === 1)
      return {
        name: str(r.name),
        kind: str(r.kind) === 'function' ? ('function' as const) : ('procedure' as const),
        returns: ret ? this.paramType(ret) : undefined,
        params: args
          .filter((p) => num(p.ret) !== 1)
          .map((p) => ({ name: str(p.pname), type: this.paramType(p), mode: num(p.ptype) === 1 ? ('OUT' as const) : ('IN' as const) }))
      }
    })
  }

  async getTableStructure(ref: DbObjectRef): Promise<TableStructure> {
    const rel = this.lit(ref.name)
    const identity = this.version >= V3 ? ', RF.RDB$IDENTITY_TYPE AS IDENTITY_TYPE' : ''
    const colRows = await queryObjects(
      this.query,
      `SELECT TRIM(RF.RDB$FIELD_NAME) AS NAME, TRIM(RF.RDB$FIELD_SOURCE) AS SRC, ${this.fieldColumns('F')},
              RF.RDB$NULL_FLAG AS NULL_FLAG, F.RDB$NULL_FLAG AS DOMAIN_NULL_FLAG,
              RF.RDB$DEFAULT_SOURCE AS DEF, F.RDB$DEFAULT_SOURCE AS DOMAIN_DEF, F.RDB$COMPUTED_SOURCE AS COMPUTED,
              RF.RDB$DESCRIPTION AS DESCR, TRIM(CS.RDB$CHARACTER_SET_NAME) AS CHARSET, TRIM(CO.RDB$COLLATION_NAME) AS COLL,
              TRIM(DCO.RDB$COLLATION_NAME) AS DEFAULT_COLL${identity}
         FROM RDB$RELATION_FIELDS RF
         JOIN RDB$FIELDS F ON F.RDB$FIELD_NAME = RF.RDB$FIELD_SOURCE
         LEFT JOIN RDB$CHARACTER_SETS CS ON CS.RDB$CHARACTER_SET_ID = F.RDB$CHARACTER_SET_ID
         LEFT JOIN RDB$COLLATIONS CO ON CO.RDB$CHARACTER_SET_ID = F.RDB$CHARACTER_SET_ID
              AND CO.RDB$COLLATION_ID = COALESCE(RF.RDB$COLLATION_ID, F.RDB$COLLATION_ID)
         LEFT JOIN RDB$COLLATIONS DCO ON DCO.RDB$CHARACTER_SET_ID = F.RDB$CHARACTER_SET_ID AND DCO.RDB$COLLATION_ID = 0
        WHERE RF.RDB$RELATION_NAME = ${rel}
        ORDER BY RF.RDB$FIELD_POSITION`
    )
    const columns: ColumnDef[] = colRows.map((c) => {
      const t = fbTypeName(c)
      const src = str(c.src)
      const isDomain = !src.startsWith('RDB$')
      const computed = optStr(c.computed)
      const identityType = num(c.identity_type)
      const coll = optStr(c.coll)
      return {
        name: str(c.name),
        originalName: str(c.name),
        dataType: t.base,
        fullType: t.full,
        length: num(c.f_char_len),
        precision: num(c.f_precision),
        scale: c.f_scale !== null ? -(num(c.f_scale) ?? 0) : undefined,
        nullable: !(num(c.null_flag) === 1 || num(c.domain_null_flag) === 1),
        defaultValue: stripDefault(optStr(c.def) ?? (isDomain ? undefined : optStr(c.domain_def))),
        identity: identityType === 0 ? 'always' : identityType === 1 ? 'by_default' : undefined,
        autoIncrement: identityType === 0 || identityType === 1,
        generated: computed ? { expression: computed.replace(/^\((.*)\)$/s, '$1'), stored: false } : undefined,
        charset: optStr(c.charset),
        collation: coll && coll !== optStr(c.default_coll) ? coll : undefined,
        comment: optStr(c.descr),
        domain: isDomain ? src : undefined
      }
    })

    const condition = this.version >= V5 ? ', I.RDB$CONDITION_SOURCE AS COND' : ''
    const idxRows = await queryObjects(
      this.query,
      `SELECT TRIM(I.RDB$INDEX_NAME) AS NAME, I.RDB$UNIQUE_FLAG AS UNQ, I.RDB$INDEX_TYPE AS ITYPE, I.RDB$EXPRESSION_SOURCE AS EXPR,
              TRIM(S.RDB$FIELD_NAME) AS COL, TRIM(RC.RDB$CONSTRAINT_TYPE) AS CTYPE, TRIM(RC.RDB$CONSTRAINT_NAME) AS CNAME,
              I.RDB$DESCRIPTION AS DESCR${condition}
         FROM RDB$INDICES I
         LEFT JOIN RDB$INDEX_SEGMENTS S ON S.RDB$INDEX_NAME = I.RDB$INDEX_NAME
         LEFT JOIN RDB$RELATION_CONSTRAINTS RC ON RC.RDB$INDEX_NAME = I.RDB$INDEX_NAME
        WHERE I.RDB$RELATION_NAME = ${rel} AND COALESCE(I.RDB$SYSTEM_FLAG, 0) = 0
        ORDER BY I.RDB$INDEX_NAME, S.RDB$FIELD_POSITION`
    )
    const indexes: IndexDef[] = []
    for (const [name, parts] of groupBy(idxRows, (r) => str(r.name))) {
      const f = parts[0]
      const ctype = optStr(f.ctype)
      if (ctype === 'FOREIGN KEY') continue
      const isConstraint = ctype === 'PRIMARY KEY' || ctype === 'UNIQUE'
      indexes.push({
        name: isConstraint ? str(f.cname) : name,
        type: ctype === 'PRIMARY KEY' ? 'PRIMARY' : num(f.unq) === 1 ? 'UNIQUE' : 'INDEX',
        columns: parts.map((p) => str(p.col)).filter(Boolean),
        expression: optStr(f.expr)?.replace(/^\((.*)\)$/s, '$1'),
        condition: optStr(f.cond)?.replace(/^\s*WHERE\s+/i, ''),
        descending: num(f.itype) === 1,
        constraint: isConstraint,
        comment: optStr(f.descr)
      })
    }

    const fkRows = await queryObjects(
      this.query,
      `SELECT TRIM(RC.RDB$CONSTRAINT_NAME) AS NAME, TRIM(S.RDB$FIELD_NAME) AS COL, TRIM(RCR.RDB$RELATION_NAME) AS REFTABLE,
              TRIM(SR.RDB$FIELD_NAME) AS REFCOL, TRIM(REF.RDB$UPDATE_RULE) AS UPD, TRIM(REF.RDB$DELETE_RULE) AS DEL
         FROM RDB$RELATION_CONSTRAINTS RC
         JOIN RDB$REF_CONSTRAINTS REF ON REF.RDB$CONSTRAINT_NAME = RC.RDB$CONSTRAINT_NAME
         JOIN RDB$RELATION_CONSTRAINTS RCR ON RCR.RDB$CONSTRAINT_NAME = REF.RDB$CONST_NAME_UQ
         JOIN RDB$INDEX_SEGMENTS S ON S.RDB$INDEX_NAME = RC.RDB$INDEX_NAME
         JOIN RDB$INDEX_SEGMENTS SR ON SR.RDB$INDEX_NAME = RCR.RDB$INDEX_NAME AND SR.RDB$FIELD_POSITION = S.RDB$FIELD_POSITION
        WHERE RC.RDB$RELATION_NAME = ${rel} AND RC.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY'
        ORDER BY RC.RDB$CONSTRAINT_NAME, S.RDB$FIELD_POSITION`
    )
    const foreignKeys: ForeignKeyDef[] = [...groupBy(fkRows, (r) => str(r.name))].map(([name, parts]) => ({
      name,
      columns: parts.map((p) => str(p.col)),
      refTable: str(parts[0].reftable),
      refColumns: parts.map((p) => str(p.refcol)),
      onUpdate: fkRule(parts[0].upd),
      onDelete: fkRule(parts[0].del)
    }))

    const ckRows = await queryObjects(
      this.query,
      `SELECT DISTINCT TRIM(RC.RDB$CONSTRAINT_NAME) AS NAME, T.RDB$TRIGGER_SOURCE AS SRC
         FROM RDB$RELATION_CONSTRAINTS RC
         JOIN RDB$CHECK_CONSTRAINTS CC ON CC.RDB$CONSTRAINT_NAME = RC.RDB$CONSTRAINT_NAME
         JOIN RDB$TRIGGERS T ON T.RDB$TRIGGER_NAME = CC.RDB$TRIGGER_NAME
        WHERE RC.RDB$RELATION_NAME = ${rel} AND RC.RDB$CONSTRAINT_TYPE = 'CHECK'`
    )
    const checks: CheckDef[] = ckRows.map((r) => ({ name: str(r.name), expression: str(r.src).replace(/^\s*CHECK\s*/i, '') }))

    const desc = await queryObjects(this.query, `SELECT RDB$DESCRIPTION AS DESCR FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = ${rel}`)
    return { ref: { ...ref, kind: 'table' }, columns, indexes, foreignKeys, checks, options: { comment: optStr(desc[0]?.descr) } }
  }

  private async parameters(table: 'RDB$PROCEDURE_PARAMETERS' | 'RDB$FUNCTION_ARGUMENTS', nameCol: string, name: string): Promise<Row[]> {
    const pkg = this.version >= V3 ? ' AND P.RDB$PACKAGE_NAME IS NULL' : ''
    const paramName = table === 'RDB$PROCEDURE_PARAMETERS' ? 'RDB$PARAMETER_NAME' : 'RDB$ARGUMENT_NAME'
    const typeCol = table === 'RDB$PROCEDURE_PARAMETERS' ? 'P.RDB$PARAMETER_TYPE' : '0'
    const posCol = table === 'RDB$PROCEDURE_PARAMETERS' ? 'P.RDB$PARAMETER_NUMBER' : 'P.RDB$ARGUMENT_POSITION'
    return queryObjects(
      this.query,
      `SELECT TRIM(P.${paramName}) AS PNAME, ${typeCol} AS PTYPE, TRIM(P.RDB$FIELD_SOURCE) AS SRC, ${this.fieldColumns('F')},
              TRIM(CS.RDB$CHARACTER_SET_NAME) AS CHARSET
         FROM ${table} P
         JOIN RDB$FIELDS F ON F.RDB$FIELD_NAME = P.RDB$FIELD_SOURCE
         LEFT JOIN RDB$CHARACTER_SETS CS ON CS.RDB$CHARACTER_SET_ID = F.RDB$CHARACTER_SET_ID
        WHERE P.${nameCol} = ${this.lit(name)}${pkg}
        ORDER BY ${typeCol}, ${posCol}`
    )
  }

  private paramType(p: Row): string {
    const src = str(p.src)
    return src.startsWith('RDB$') ? fbTypeName(p).full : src
  }

  async getObjectDDL(ref: DbObjectRef): Promise<string> {
    const name = this.lit(ref.name)
    const q = this.dialect.quoteIdent(ref.name)
    switch (ref.kind) {
      case 'table':
        return this.dialect.createTable(await this.getTableStructure(ref)).join(';\n') + ';'
      case 'view': {
        const r = await queryObjects(this.query, `SELECT RDB$VIEW_SOURCE AS SRC FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = ${name}`)
        const cols = await queryObjects(
          this.query,
          `SELECT TRIM(RDB$FIELD_NAME) AS N FROM RDB$RELATION_FIELDS WHERE RDB$RELATION_NAME = ${name} ORDER BY RDB$FIELD_POSITION`
        )
        return `CREATE OR ALTER VIEW ${q} (${cols.map((c) => this.dialect.quoteIdent(str(c.n))).join(', ')})\nAS\n${str(r[0]?.src).trim()};`
      }
      case 'procedure': {
        const r = await queryObjects(
          this.query,
          `SELECT RDB$PROCEDURE_SOURCE AS SRC FROM RDB$PROCEDURES WHERE RDB$PROCEDURE_NAME = ${name}${this.version >= V3 ? ' AND RDB$PACKAGE_NAME IS NULL' : ''}`
        )
        const params = await this.parameters('RDB$PROCEDURE_PARAMETERS', 'RDB$PROCEDURE_NAME', ref.name)
        const fmt = (list: Row[]): string => list.map((p) => `  ${this.dialect.quoteIdent(str(p.pname))} ${this.paramType(p)}`).join(',\n')
        const inputs = params.filter((p) => num(p.ptype) === 0)
        const outputs = params.filter((p) => num(p.ptype) === 1)
        return [
          'SET TERM ^ ;',
          `CREATE OR ALTER PROCEDURE ${q}${inputs.length ? ` (\n${fmt(inputs)}\n)` : ''}`,
          outputs.length ? `RETURNS (\n${fmt(outputs)}\n)` : '',
          'AS',
          `${str(r[0]?.src).trim()}^`,
          'SET TERM ; ^'
        ]
          .filter(Boolean)
          .join('\n')
      }
      case 'function': {
        if (this.version < V3) return `-- Legacy UDF ${ref.name}: declared with DECLARE EXTERNAL FUNCTION.`
        const r = await queryObjects(
          this.query,
          `SELECT RDB$FUNCTION_SOURCE AS SRC, TRIM(RDB$ENGINE_NAME) AS ENG, RDB$ENTRYPOINT AS ENTRY, RDB$RETURN_ARGUMENT AS RETARG
             FROM RDB$FUNCTIONS WHERE RDB$FUNCTION_NAME = ${name} AND RDB$PACKAGE_NAME IS NULL`
        )
        const args = await queryObjects(
          this.query,
          `SELECT TRIM(A.RDB$ARGUMENT_NAME) AS PNAME, A.RDB$ARGUMENT_POSITION AS POS, TRIM(A.RDB$FIELD_SOURCE) AS SRC, ${this.fieldColumns('F')},
                  TRIM(CS.RDB$CHARACTER_SET_NAME) AS CHARSET
             FROM RDB$FUNCTION_ARGUMENTS A
             JOIN RDB$FIELDS F ON F.RDB$FIELD_NAME = A.RDB$FIELD_SOURCE
             LEFT JOIN RDB$CHARACTER_SETS CS ON CS.RDB$CHARACTER_SET_ID = F.RDB$CHARACTER_SET_ID
            WHERE A.RDB$FUNCTION_NAME = ${name} AND A.RDB$PACKAGE_NAME IS NULL ORDER BY A.RDB$ARGUMENT_POSITION`
        )
        const retPos = num(r[0]?.retarg) ?? 0
        const ret = args.find((a) => num(a.pos) === retPos)
        const inputs = args.filter((a) => num(a.pos) !== retPos)
        const body = optStr(r[0]?.src) ?? `EXTERNAL NAME ${this.lit(str(r[0]?.entry))} ENGINE ${str(r[0]?.eng)}`
        return [
          'SET TERM ^ ;',
          `CREATE OR ALTER FUNCTION ${q} (${inputs.map((a) => `${this.dialect.quoteIdent(str(a.pname))} ${this.paramType(a)}`).join(', ')})`,
          `RETURNS ${ret ? this.paramType(ret) : 'INTEGER'}`,
          optStr(r[0]?.src) ? 'AS' : '',
          `${body.trim()}^`,
          'SET TERM ; ^'
        ]
          .filter(Boolean)
          .join('\n')
      }
      case 'trigger': {
        const r = await queryObjects(
          this.query,
          `SELECT TRIM(RDB$RELATION_NAME) AS REL, RDB$TRIGGER_TYPE AS TTYPE, RDB$TRIGGER_SEQUENCE AS SEQ, RDB$TRIGGER_INACTIVE AS INACTIVE,
                  RDB$TRIGGER_SOURCE AS SRC FROM RDB$TRIGGERS WHERE RDB$TRIGGER_NAME = ${name}`
        )
        const t = r[0]
        if (!t) throw new Error(`Trigger not found: ${ref.name}`)
        const rel = optStr(t.rel)
        const target = rel ? `FOR ${this.dialect.quoteIdent(rel)} ` : ''
        return [
          'SET TERM ^ ;',
          `CREATE OR ALTER TRIGGER ${q} ${target}${num(t.inactive) === 1 ? 'INACTIVE' : 'ACTIVE'} ${decodeTriggerType(num(t.ttype) ?? 0)} POSITION ${num(t.seq) ?? 0}`,
          `${str(t.src).trim()}^`,
          'SET TERM ; ^'
        ].join('\n')
      }
      case 'sequence': {
        const cur = await this.query(`SELECT GEN_ID(${q}, 0) FROM RDB$DATABASE`)
        const value = str(cur.rows[0]?.[0])
        // CREATE/ALTER SEQUENCE is accepted since Firebird 2.0.
        return `CREATE SEQUENCE ${q};\nALTER SEQUENCE ${q} RESTART WITH ${value};`
      }
      case 'domain': {
        const r = await queryObjects(
          this.query,
          `SELECT ${this.fieldColumns('F')}, F.RDB$DEFAULT_SOURCE AS DEF, F.RDB$NULL_FLAG AS NULL_FLAG, F.RDB$VALIDATION_SOURCE AS VAL,
                  TRIM(CS.RDB$CHARACTER_SET_NAME) AS CHARSET
             FROM RDB$FIELDS F LEFT JOIN RDB$CHARACTER_SETS CS ON CS.RDB$CHARACTER_SET_ID = F.RDB$CHARACTER_SET_ID
            WHERE F.RDB$FIELD_NAME = ${name}`
        )
        const d = r[0]
        if (!d) throw new Error(`Domain not found: ${ref.name}`)
        return `CREATE DOMAIN ${q} AS ${fbTypeName(d).full}${d.def ? ` ${str(d.def)}` : ''}${num(d.null_flag) === 1 ? ' NOT NULL' : ''}${d.val ? ` ${str(d.val)}` : ''};`
      }
      case 'exception': {
        const r = await queryObjects(this.query, `SELECT RDB$MESSAGE AS MSG FROM RDB$EXCEPTIONS WHERE RDB$EXCEPTION_NAME = ${name}`)
        return `CREATE OR ALTER EXCEPTION ${q} ${this.lit(str(r[0]?.msg))};`
      }
      case 'package': {
        const r = await queryObjects(
          this.query,
          `SELECT RDB$PACKAGE_HEADER_SOURCE AS H, RDB$PACKAGE_BODY_SOURCE AS B FROM RDB$PACKAGES WHERE RDB$PACKAGE_NAME = ${name}`
        )
        const p = r[0]
        if (!p) throw new Error(`Package not found: ${ref.name}`)
        const parts = ['SET TERM ^ ;', `CREATE OR ALTER PACKAGE ${q}\nAS\n${str(p.h).trim()}^`]
        if (p.b) parts.push(`RECREATE PACKAGE BODY ${q}\nAS\n${str(p.b).trim()}^`)
        parts.push('SET TERM ; ^')
        return parts.join('\n')
      }
      default:
        throw new Error(`No DDL available for ${ref.kind}`)
    }
  }

  getRoutineSource(ref: DbObjectRef): Promise<string> {
    return this.getObjectDDL(ref)
  }

  async listCollations(): Promise<CollationInfo[]> {
    const rows = await queryObjects(
      this.query,
      `SELECT TRIM(CS.RDB$CHARACTER_SET_NAME) AS CS, TRIM(C.RDB$COLLATION_NAME) AS CO, C.RDB$COLLATION_ID AS ID,
              CASE WHEN CS.RDB$CHARACTER_SET_NAME = (SELECT D.RDB$CHARACTER_SET_NAME FROM RDB$DATABASE D) THEN 1 ELSE 0 END AS DB
         FROM RDB$COLLATIONS C JOIN RDB$CHARACTER_SETS CS ON CS.RDB$CHARACTER_SET_ID = C.RDB$CHARACTER_SET_ID ORDER BY 1, 2`
    )
    // A column's collation must belong to its character set (the database default when none is given).
    return rows.map((r) => ({ charset: str(r.cs), collation: str(r.co), isDefault: num(r.id) === 0, databaseCharset: num(r.db) === 1 }))
  }

  async listEngines(): Promise<string[]> {
    return []
  }

  async countRows(ref: DbObjectRef, where?: string): Promise<number> {
    const res = await this.query(`SELECT COUNT(*) FROM ${this.dialect.qualify(ref)}${where?.trim() ? ` WHERE ${where}` : ''}`)
    return Number(res.rows[0]?.[0] ?? 0)
  }

  async hostInfo(): Promise<HostInfo> {
    const dbRows = await queryObjects(this.query, 'SELECT * FROM MON$DATABASE')
    const status = keyValueResult(Object.entries(dbRows[0] ?? {}).map(([k, v]) => [k.toUpperCase(), v]))
    const variables =
      this.version >= V4
        ? await this.query('SELECT TRIM(RDB$CONFIG_NAME) AS "Variable", RDB$CONFIG_VALUE AS "Value", RDB$CONFIG_DEFAULT AS "Default", RDB$CONFIG_SOURCE AS "Source" FROM RDB$CONFIG ORDER BY 1')
        : keyValueResult([
            ['ENGINE_VERSION', str((await this.query("SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION') FROM RDB$DATABASE")).rows[0]?.[0])],
            ['ODS', `${str(dbRows[0]?.['mon$ods_major'])}.${str(dbRows[0]?.['mon$ods_minor'])}`],
            ['PAGE_SIZE', dbRows[0]?.['mon$page_size'] ?? null],
            ['SQL_DIALECT', dbRows[0]?.['mon$sql_dialect'] ?? null]
          ])
    const processes = await this.query(
      `SELECT A.MON$ATTACHMENT_ID AS "Id", TRIM(A.MON$USER) AS "User", TRIM(A.MON$REMOTE_ADDRESS) AS "Host",
              TRIM(A.MON$REMOTE_PROCESS) AS "Application", A.MON$STATE AS "State", A.MON$TIMESTAMP AS "Started",
              (SELECT FIRST 1 S.MON$SQL_TEXT FROM MON$STATEMENTS S WHERE S.MON$ATTACHMENT_ID = A.MON$ATTACHMENT_ID AND S.MON$STATE = 1) AS "Info"
         FROM MON$ATTACHMENTS A ${this.version >= V3 ? 'WHERE A.MON$SYSTEM_FLAG = 0' : ''} ORDER BY A.MON$ATTACHMENT_ID`
    )
    return { variables, status, processes }
  }

  async killProcess(id: string | number, queryOnly: boolean): Promise<void> {
    const table = queryOnly ? 'MON$STATEMENTS' : 'MON$ATTACHMENTS'
    await this.query(`DELETE FROM ${table} WHERE MON$ATTACHMENT_ID = ${Number(id)}`)
  }

  async listUsers(): Promise<ServerUser[]> {
    if (this.version >= V3) {
      const rows = await queryObjects(this.query, 'SELECT TRIM(SEC$USER_NAME) AS N, SEC$ADMIN AS ADM, SEC$ACTIVE AS ACT FROM SEC$USERS ORDER BY 1')
      return rows.map((r) => ({ name: str(r.n), superuser: r.adm === true || num(r.adm) === 1, canLogin: r.act !== false && num(r.act) !== 0 }))
    }
    const rows = await queryObjects(this.query, 'SELECT DISTINCT TRIM(RDB$USER) AS N FROM RDB$USER_PRIVILEGES WHERE RDB$USER_TYPE = 8 ORDER BY 1')
    return rows.map((r) => ({ name: str(r.n), canLogin: true }))
  }

  async getUserPrivileges(user: ServerUser): Promise<UserPrivileges> {
    const rows = await queryObjects(
      this.query,
      `SELECT TRIM(RDB$PRIVILEGE) AS P, TRIM(RDB$RELATION_NAME) AS R, RDB$GRANT_OPTION AS G
         FROM RDB$USER_PRIVILEGES WHERE RDB$USER = ${this.lit(user.name.toUpperCase())} ORDER BY 2, 1`
    )
    const names: Record<string, string> = { S: 'SELECT', I: 'INSERT', U: 'UPDATE', D: 'DELETE', R: 'REFERENCES', X: 'EXECUTE', M: 'ROLE' }
    const grants = [...groupBy(rows, (r) => str(r.r))].map(
      ([rel, ps]) => `GRANT ${ps.map((p) => names[str(p.p)] ?? str(p.p)).join(', ')} ON ${this.dialect.quoteIdent(rel)} TO ${this.dialect.quoteIdent(user.name)}`
    )
    return { user, grants }
  }
}

/** Decodes RDB$TRIGGER_TYPE into its DDL clause (supports multi-action and database/DDL triggers). */
const FB_DB_EVENTS: Record<number, TriggerDatabaseEvent> = {
  8192: 'CONNECT', 8193: 'DISCONNECT', 8194: 'TRANSACTION START', 8195: 'TRANSACTION COMMIT', 8196: 'TRANSACTION ROLLBACK'
}

/** RDB$TRIGGER_TYPE decoded: table triggers pack up to three actions in 2-bit slots after the BEFORE/AFTER bit. */
export function decodeTriggerParts(type: number): { timing: 'BEFORE' | 'AFTER'; events: TriggerEvent[]; databaseEvent?: TriggerDatabaseEvent; ddl?: boolean } {
  const dbEvent = FB_DB_EVENTS[type]
  if (dbEvent) return { timing: 'BEFORE', events: [], databaseEvent: dbEvent }
  if ((type & 0x4000) !== 0) return { timing: type & 1 ? 'AFTER' : 'BEFORE', events: [], ddl: true }
  const actions: TriggerEvent[] = ['INSERT', 'UPDATE', 'DELETE']
  const events: TriggerEvent[] = []
  for (let n = 0; n < 3; n++) {
    const code = ((type + 1) >> (n * 2 + 1)) & 3
    if (code) events.push(actions[code - 1])
  }
  return { timing: (type + 1) & 1 ? 'AFTER' : 'BEFORE', events }
}

export function decodeTriggerType(type: number): string {
  const p = decodeTriggerParts(type)
  if (p.databaseEvent) return `ON ${p.databaseEvent}`
  if (p.ddl) return `${p.timing} ANY DDL STATEMENT`
  return `${p.timing} ${p.events.join(' OR ')}`
}
