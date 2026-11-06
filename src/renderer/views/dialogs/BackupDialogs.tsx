import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, RefreshCw, Search } from "lucide-react";
import type {
  BackupFileInfo,
  BackupMethod,
  BackupObjectKinds,
  BackupTableSelection,
  BackupToolInfo,
  DbEngine,
  LogicalBackupOptions,
  ProgressInfo,
  RestoreMethod,
} from "@shared/model";
import { ENGINE_LABELS } from "@shared/model";
import { hasCapability } from "@domain/serverVersion";
import { isFileBased, isSingleDatabase } from "@domain/engineTraits";
import { backupStamp } from "@domain/backup/backupHeader";
import { useWorkspace } from "../../stores/workspaceStore";
import { useUi, type DialogState } from "../../stores/uiStore";
import { useBackup, type BackupTableRow } from "../../stores/backupStore";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  Select,
  Spinner,
  cx,
} from "../../components/ui";
import { confirmDialog } from "../../components/ui/prompts";
import { api } from "../../gateways/api";
import { notify } from "../../stores/toast";
import { formatBytes, uid } from "../../lib/format";
import { useProgress } from "./useProgress";

function Progress({ p }: { p: ProgressInfo | null }) {
  const { t } = useTranslation();
  if (!p) return null;
  const pct = p.totalBytes
    ? Math.min(100, Math.floor(((p.bytes ?? 0) / p.totalBytes) * 100))
    : null;
  return (
    <span className="mr-auto flex min-w-0 items-center gap-2 text-xs text-muted">
      {!p.finished && <Spinner size={12} />}
      {p.phase && <Badge>{t(`backup.phase.${p.phase}`)}</Badge>}
      <span className="truncate">
        {p.object ? `${p.object} · ` : ""}
        {p.done.toLocaleString()}
        {pct !== null
          ? ` · ${pct}%`
          : p.bytes
            ? ` · ${formatBytes(p.bytes)}`
            : ""}
      </span>
      {p.error && <span className="truncate text-danger">{p.error}</span>}
    </span>
  );
}

const TOOL_FOR_METHOD: Partial<
  Record<BackupMethod | RestoreMethod, BackupToolInfo["tool"][]>
> = {
  mysqldump: ["mariadb-dump", "mysqldump"],
  mysql: ["mariadb", "mysql"],
  pg_dump: ["pg_dump"],
  pg_restore: ["pg_restore"],
  psql: ["psql"],
  gbak: ["gbak"],
};

function toolFor(
  tools: BackupToolInfo[],
  method: BackupMethod | RestoreMethod,
): BackupToolInfo | undefined {
  const names = TOOL_FOR_METHOD[method] ?? [];
  const all = names
    .map((n) => tools.find((t) => t.tool === n))
    .filter((x): x is BackupToolInfo => !!x);
  return all.find((x) => x.compatible) ?? all[0];
}

const DEFAULT_OBJECTS: BackupObjectKinds = {
  views: true,
  routines: true,
  triggers: true,
  sequences: true,
  domainsAndTypes: true,
  events: true,
  materializedViews: true,
  extensions: true,
};

function extension(
  method: BackupMethod,
  compress: boolean,
  pgFormat: "custom" | "plain",
): string {
  if (method === "sqlite-file") return compress ? "db.gz" : "db";
  if (method === "gbak" || method === "firebird-service")
    return compress && method === "gbak" ? "fbk.gz" : "fbk";
  if (method === "pg_dump" && pgFormat === "custom") return "backup";
  return compress ? "sql.gz" : "sql";
}

/* ------------------------------------------------------------------------ */

export function BackupDialog({
  d,
}: {
  d: Extract<DialogState, { kind: "backup" }>;
}) {
  const { t } = useTranslation();
  const close = useUi((s) => s.closeDialog);
  const session = useWorkspace((s) => s.sessions[d.sessionId]);
  const vm = useBackup();
  const [opId] = useState(uid);
  const progress = useProgress(session, opId);
  const [busy, setBusy] = useState(false);
  const engine = session?.info.engine ?? "mysql";
  const caps = session?.info.capabilities ?? [];
  const single = isSingleDatabase(engine);
  const isMy = engine === "mysql" || engine === "mariadb";
  const isPg = engine === "postgres";
  const isFb = engine === "firebird";

  const [method, setMethod] = useState<BackupMethod>("logical");
  const [tools, setTools] = useState<BackupToolInfo[] | null>(null);
  const [dbs, setDbs] = useState<string[]>(
    d.database
      ? [d.database]
      : session?.info.currentDatabase && !single
        ? [session.info.currentDatabase]
        : [],
  );
  const [tables, setTables] = useState<BackupTableRow[] | null>(null);
  const [choice, setChoice] = useState<
    Record<string, { include: boolean; data: boolean }>
  >({});
  const [filter, setFilter] = useState("");
  const [file, setFile] = useState("");
  const [compress, setCompress] = useState(true);
  const [pgFormat, setPgFormat] = useState<"custom" | "plain">("custom");
  const [serverPath, setServerPath] = useState("");
  const [extraArgs, setExtraArgs] = useState("");
  const [o, setO] = useState<
    Omit<LogicalBackupOptions, "databases" | "tables">
  >({
    objects: DEFAULT_OBJECTS,
    sequenceValues: true,
    usersAndGrants: false,
    createDatabase: false,
    dropObjects: engine !== "firebird",
    stripDefiners: true,
    includeOwners: false,
    consistentSnapshot: true,
    rowsPerInsert: 500,
  });
  const set = (patch: Partial<typeof o>): void =>
    setO((x) => ({ ...x, ...patch }));
  const setKind = (patch: Partial<BackupObjectKinds>): void =>
    setO((x) => ({ ...x, objects: { ...x.objects, ...patch } }));

  useEffect(() => {
    if (!session || isFileBased(engine)) return setTools([]);
    vm.detectTools(session.id).then(setTools, () => setTools([]));
  }, [session?.id]);

  // Tables of the one selected database (several databases: everything).
  const tableDb = single ? "" : dbs.length === 1 ? dbs[0] : null;
  useEffect(() => {
    if (!session || tableDb === null) return setTables(null);
    setTables(null);
    vm.listTables(session.id, tableDb).then(
      (rows) => {
        setTables(rows);
        setChoice(
          Object.fromEntries(
            rows.map((r) => [key(r), { include: true, data: true }]),
          ),
        );
      },
      (err) => notify.error(err),
    );
  }, [session?.id, tableDb]);

  const visible = useMemo(
    () =>
      (tables ?? []).filter(
        (r) =>
          !filter ||
          `${r.schema ?? ""}.${r.name}`
            .toLowerCase()
            .includes(filter.toLowerCase()),
      ),
    [tables, filter],
  );
  if (!session) return null;

  const methods: {
    value: BackupMethod;
    label: string;
    disabled?: boolean;
    hint?: string;
  }[] = [{ value: "logical", label: t("backup.methodLogical") }];
  if (engine === "sqlite")
    methods.push({ value: "sqlite-file", label: t("backup.methodSqliteFile") });
  if (isFb)
    methods.push({
      value: "firebird-service",
      label: t("backup.methodFirebirdService"),
    });
  for (const m of ["mysqldump", "pg_dump", "gbak"] as const) {
    if (
      (m === "mysqldump" && !isMy) ||
      (m === "pg_dump" && !isPg) ||
      (m === "gbak" && !isFb)
    )
      continue;
    const tool = toolFor(tools ?? [], m);
    methods.push({
      value: m,
      label: tool
        ? `${tool.tool} ${tool.version}`
        : t("backup.toolMissing", { tool: m }),
      disabled: !tool || !tool.compatible,
      hint: tool?.reason,
    });
  }
  const current = methods.find((m) => m.value === method);
  const logical = method === "logical";
  const native =
    method === "mysqldump" || method === "pg_dump" || method === "gbak";
  const usesServerPath =
    method === "firebird-service" || (method === "gbak" && !!serverPath);
  const canCompress =
    method !== "firebird-service" &&
    !(method === "pg_dump" && pgFormat === "custom") &&
    !(method === "gbak" && serverPath);
  const ext = extension(method, compress && canCompress, pgFormat);

  const browse = async (): Promise<void> => {
    const base =
      (single
        ? (session.profile.database ?? "database")
            .split(/[\\/]/)
            .pop()!
            .replace(/\.[^.]+$/, "")
        : dbs[0]) || "backup";
    const f = await api.invoke("dialog:saveFile", {
      defaultPath: `${base}_${backupStamp()}.${ext}`,
      filters: [
        { name: ext.toUpperCase(), extensions: [ext.split(".").pop()!] },
      ],
    });
    if (f) setFile(f);
  };

  const selection = (): Record<string, BackupTableSelection[]> | undefined => {
    if (tableDb === null || !tables) return undefined;
    const chosen = tables.filter((r) => choice[key(r)]?.include);
    if (
      chosen.length === tables.length &&
      chosen.every((r) => choice[key(r)]?.data)
    )
      return undefined;
    return {
      [tableDb]: chosen.map((r) => ({
        schema: r.schema,
        name: r.name,
        data: choice[key(r)]?.data ?? true,
      })),
    };
  };

  const run = async (): Promise<void> => {
    if (!usesServerPath && !file) return;
    setBusy(true);
    try {
      const r = await vm.backup(session.id, {
        operationId: opId,
        filePath: file,
        method,
        compress: compress && canCompress,
        logical: {
          ...o,
          dropObjects: o.dropObjects && !(isFb && logical),
          databases: single ? [""] : dbs,
          tables: selection(),
        },
        // The detected path: tools configured in Settings → Backup tools are not on PATH.
        native:
          native || method === "firebird-service"
            ? {
                toolPath: toolFor(tools ?? [], method)?.path,
                pgFormat,
                serverPath: serverPath || undefined,
                extraArgs: splitArgs(extraArgs),
              }
            : undefined,
      });
      notify.success(
        t("backup.done", {
          file: r.files.join(", "),
          size: formatBytes(r.bytes),
        }),
      );
      for (const w of r.warnings.slice(0, 5)) notify.info(w);
      if (!usesServerPath && r.files[0])
        void api.invoke("shell:showItem", r.files[0]);
      close();
    } catch (err) {
      notify.error(err);
    } finally {
      setBusy(false);
    }
  };

  const allIncluded =
    !!tables?.length && tables.every((r) => choice[key(r)]?.include);
  const allData = !!tables?.length && tables.every((r) => choice[key(r)]?.data);
  const setAll = (field: "include" | "data", v: boolean): void =>
    setChoice((c) =>
      Object.fromEntries(
        Object.entries(c).map(([k, x]) => [k, { ...x, [field]: v }]),
      ),
    );

  return (
    <Dialog
      open
      onOpenChange={(v) => !v && !busy && close()}
      title={t("backup.title", { engine: ENGINE_LABELS[engine] })}
      width={820}
      footer={
        <>
          <Progress p={progress} />
          {busy ? (
            <Button onClick={() => vm.cancel(session.id, opId)}>
              {t("common.cancel")}
            </Button>
          ) : (
            <Button onClick={close}>{t("common.cancel")}</Button>
          )}
          <Button
            variant="primary"
            loading={busy}
            disabled={
              (!usesServerPath && !file) ||
              (!single && !dbs.length) ||
              !!current?.disabled
            }
            onClick={() => void run()}
          >
            {t("backup.start")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 p-4">
        <div className="grid grid-cols-[1fr_auto] items-start gap-2">
          <Field
            label={t("backup.method")}
            hint={
              current?.hint ??
              t(`backup.methodHint.${method}`, { defaultValue: "" })
            }
          >
            <Select
              value={method}
              onChange={(e) => setMethod(e.target.value as BackupMethod)}
            >
              {methods.map((m) => (
                <option key={m.value} value={m.value} disabled={m.disabled}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
          {!isFileBased(engine) && (
            // The label above the select is 20px tall: line the button up with the select, not the hint.
            <div className="mt-5">
              <Button
                icon={
                  tools === null ? (
                    <Spinner size={13} />
                  ) : (
                    <RefreshCw size={13} />
                  )
                }
                onClick={() => {
                  setTools(null);
                  vm.detectTools(session.id, true).then(setTools, () =>
                    setTools([]),
                  );
                }}
              >
                {t("backup.detectTools")}
              </Button>
            </div>
          )}
        </div>

        {(logical || native) && (
          <div className="grid grid-cols-[260px_1fr] gap-4">
            <div className="flex flex-col gap-2">
              {!single && (
                <Field
                  label={t("dump.databases")}
                  hint={
                    isPg && dbs.length > 1
                      ? t("backup.pgOneFilePerDb")
                      : undefined
                  }
                >
                  <div className="h-40 overflow-auto rounded-md border border-border bg-sunken p-2">
                    {(session.databases ?? []).map((db) => (
                      <Checkbox
                        key={db}
                        block
                        className="py-0.5"
                        checked={dbs.includes(db)}
                        onChange={(v) =>
                          setDbs((x) =>
                            v ? [...x, db] : x.filter((y) => y !== db),
                          )
                        }
                        label={db}
                      />
                    ))}
                  </div>
                </Field>
              )}
              {logical && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted">
                    {t("backup.objects")}
                  </span>
                  <Checkbox
                    checked={o.objects.views}
                    onChange={(v) => setKind({ views: v })}
                    label={t("dump.views")}
                  />
                  {hasCapability(caps, "materializedViews") && (
                    <Checkbox
                      checked={o.objects.materializedViews}
                      onChange={(v) => setKind({ materializedViews: v })}
                      label={t("backup.materializedViews")}
                    />
                  )}
                  {engine !== "sqlite" && (
                    <Checkbox
                      checked={o.objects.routines}
                      onChange={(v) => setKind({ routines: v })}
                      label={t("dump.routines")}
                    />
                  )}
                  <Checkbox
                    checked={o.objects.triggers}
                    onChange={(v) => setKind({ triggers: v })}
                    label={t("dump.triggers")}
                  />
                  {hasCapability(caps, "sequences") && (
                    <Checkbox
                      checked={o.objects.sequences}
                      onChange={(v) => setKind({ sequences: v })}
                      label={t("backup.sequences")}
                    />
                  )}
                  {(hasCapability(caps, "domains") || isPg) && (
                    <Checkbox
                      checked={o.objects.domainsAndTypes}
                      onChange={(v) => setKind({ domainsAndTypes: v })}
                      label={
                        isFb
                          ? t("backup.domainsExceptions")
                          : t("backup.domainsTypes")
                      }
                    />
                  )}
                  {hasCapability(caps, "events") && (
                    <Checkbox
                      checked={o.objects.events}
                      onChange={(v) => setKind({ events: v })}
                      label={t("backup.events")}
                    />
                  )}
                  {isPg && (
                    <Checkbox
                      checked={o.objects.extensions}
                      onChange={(v) => setKind({ extensions: v })}
                      label={t("backup.extensions")}
                    />
                  )}
                </div>
              )}
            </div>

            <Field
              label={t("backup.tables")}
              hint={tableDb === null ? t("backup.tablesAll") : undefined}
            >
              {tableDb === null ? (
                <div className="flex h-64 items-center justify-center rounded-md border border-border bg-sunken text-xs text-subtle">
                  {t("backup.tablesAll")}
                </div>
              ) : !tables ? (
                <div className="flex h-64 items-center justify-center rounded-md border border-border bg-sunken">
                  <Spinner />
                </div>
              ) : (
                <div className="flex h-64 flex-col rounded-md border border-border bg-sunken">
                  <div className="flex items-center gap-2 border-b border-border px-2 py-1">
                    <Search size={12} className="text-subtle" />
                    <input
                      className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                      placeholder={t("backup.filter")}
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    />
                  </div>
                  <div className="grid grid-cols-[1fr_64px_64px_80px] items-center gap-2 border-b border-border px-2 py-1 text-[11px] text-muted">
                    <Checkbox
                      checked={allIncluded}
                      onChange={(v) => setAll("include", v)}
                      label={t("backup.table")}
                    />
                    <Checkbox
                      checked={allData}
                      onChange={(v) => setAll("data", v)}
                      label={t("backup.data")}
                    />
                    <span className="text-right">{t("backup.rows")}</span>
                    <span className="text-right">{t("backup.size")}</span>
                  </div>
                  <div className="flex-1 overflow-auto">
                    {visible.map((r) => {
                      const c = choice[key(r)] ?? { include: true, data: true };
                      const upd = (patch: Partial<typeof c>): void =>
                        setChoice((x) => ({
                          ...x,
                          [key(r)]: { ...c, ...patch },
                        }));
                      return (
                        <div
                          key={key(r)}
                          className={cx(
                            "grid grid-cols-[1fr_64px_64px_80px] items-center gap-2 px-2 py-0.5 text-xs",
                            !c.include && "opacity-60",
                          )}
                        >
                          <Checkbox
                            checked={c.include}
                            onChange={(v) => upd({ include: v })}
                            label={
                              <span className="truncate font-mono">
                                {r.schema && isPg
                                  ? `${r.schema}.${r.name}`
                                  : r.name}
                              </span>
                            }
                          />
                          <Checkbox
                            checked={c.data}
                            disabled={!c.include}
                            onChange={(v) => upd({ data: v })}
                          />
                          <span className="text-right tabular-nums text-subtle">
                            {r.rows?.toLocaleString() ?? ""}
                          </span>
                          <span className="text-right tabular-nums text-subtle">
                            {formatBytes(r.sizeBytes)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </Field>
          </div>
        )}

        {logical && (
          <div className="grid grid-cols-3 gap-x-4 gap-y-1.5">
            <Checkbox
              checked={o.sequenceValues}
              onChange={(v) => set({ sequenceValues: v })}
              label={t("backup.sequenceValues")}
            />
            {/* Firebird has no DROP … IF EXISTS: restore into a new database file instead. */}
            {!isFb && (
              <Checkbox
                checked={o.dropObjects}
                onChange={(v) => set({ dropObjects: v })}
                label={t("backup.dropObjects")}
              />
            )}
            <Checkbox
              checked={o.consistentSnapshot}
              onChange={(v) => set({ consistentSnapshot: v })}
              label={t("backup.snapshot")}
            />
            {isMy && (
              <Checkbox
                checked={o.createDatabase}
                onChange={(v) => set({ createDatabase: v })}
                label={t("dump.createDatabase")}
              />
            )}
            {isMy && (
              <Checkbox
                checked={o.stripDefiners}
                onChange={(v) => set({ stripDefiners: v })}
                label={t("backup.stripDefiners")}
              />
            )}
            {isPg && (
              <Checkbox
                checked={o.includeOwners}
                onChange={(v) => set({ includeOwners: v })}
                label={t("backup.owners")}
              />
            )}
            {engine !== "sqlite" && (
              <Checkbox
                checked={o.usersAndGrants}
                onChange={(v) => set({ usersAndGrants: v })}
                label={t("backup.usersGrants")}
              />
            )}
          </div>
        )}
        {logical && o.usersAndGrants && (
          <p className="text-[11px] text-warning">
            {t(isFb ? "backup.usersGrantsHintFb" : "backup.usersGrantsHint")}
          </p>
        )}
        {native && (
          <div className="grid grid-cols-3 gap-x-4 gap-y-1.5">
            <Checkbox
              checked={o.dropObjects}
              onChange={(v) => set({ dropObjects: v })}
              label={t("backup.dropObjects")}
            />
            {isMy && (
              <Checkbox
                checked={o.createDatabase}
                onChange={(v) => set({ createDatabase: v })}
                label={t("dump.createDatabase")}
              />
            )}
            {isPg && (
              <Checkbox
                checked={o.includeOwners}
                onChange={(v) => set({ includeOwners: v })}
                label={t("backup.owners")}
              />
            )}
            {isPg && (
              <Checkbox
                checked={o.usersAndGrants}
                onChange={(v) => set({ usersAndGrants: v })}
                label={t("backup.privileges")}
              />
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          {method === "pg_dump" && (
            <Field label={t("backup.format")}>
              <Select
                value={pgFormat}
                onChange={(e) =>
                  setPgFormat(e.target.value as "custom" | "plain")
                }
              >
                <option value="custom">{t("backup.formatCustom")}</option>
                <option value="plain">{t("backup.formatPlain")}</option>
              </Select>
            </Field>
          )}
          {(method === "firebird-service" || method === "gbak") && (
            <Field
              label={t("backup.serverPath")}
              hint={
                method === "gbak"
                  ? t("backup.serverPathOptional")
                  : t("backup.serverPathHint")
              }
              className="col-span-2"
            >
              <Input
                value={serverPath}
                onChange={(e) => setServerPath(e.target.value)}
                className="font-mono text-xs"
                placeholder={defaultServerPath(session.profile.database)}
              />
            </Field>
          )}
          {native && (
            <Field
              label={t("backup.extraArgs")}
              className={method === "pg_dump" ? "" : "col-span-2"}
            >
              <Input
                value={extraArgs}
                onChange={(e) => setExtraArgs(e.target.value)}
                className="font-mono text-xs"
              />
            </Field>
          )}
          {logical && (
            <Field label={t("export.rowsPerInsert")}>
              <Input
                type="number"
                min={1}
                value={o.rowsPerInsert}
                onChange={(e) =>
                  set({ rowsPerInsert: Number(e.target.value) || 1 })
                }
              />
            </Field>
          )}
        </div>

        {!usesServerPath && (
          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
            <Field label={t("export.file")}>
              <div className="flex gap-1.5">
                <Input
                  value={file}
                  onChange={(e) => setFile(e.target.value)}
                  className="font-mono text-xs"
                />
                <Button
                  icon={<FolderOpen size={13} />}
                  onClick={() => void browse()}
                >
                  {t("common.browse")}
                </Button>
              </div>
            </Field>
            {canCompress && (
              <Checkbox
                className="pb-2"
                checked={compress}
                onChange={setCompress}
                label={t("backup.compress")}
              />
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

const key = (r: { schema?: string; name: string }): string =>
  `${r.schema ?? ""}.${r.name}`;

function splitArgs(s: string): string[] {
  return (s.match(/"[^"]*"|\S+/g) ?? []).map((a) => a.replace(/^"|"$/g, ""));
}

function defaultServerPath(database: string | undefined): string {
  const db = database ?? "";
  const name = db.replace(/\.[^./\\]+$/, "");
  return name ? `${name}_${backupStamp()}.fbk` : "";
}

/* ------------------------------------------------------------------------ */

const RESTORE_LABELS: Record<RestoreMethod, string> = {
  logical: "restore.methodLogical",
  "sqlite-file": "restore.methodSqliteFile",
  "firebird-service": "restore.methodFirebirdService",
  mysql: "restore.methodTool",
  pg_restore: "restore.methodTool",
  psql: "restore.methodTool",
  gbak: "restore.methodTool",
};

export function RestoreDialog({
  d,
}: {
  d: Extract<DialogState, { kind: "restore" }>;
}) {
  const { t } = useTranslation();
  const close = useUi((s) => s.closeDialog);
  const session = useWorkspace((s) => s.sessions[d.sessionId]);
  const vm = useBackup();
  const [opId] = useState(uid);
  const progress = useProgress(session, opId);
  const [busy, setBusy] = useState(false);
  const engine = session?.info.engine ?? "mysql";
  const single = isSingleDatabase(engine);
  const [file, setFile] = useState("");
  const [info, setInfo] = useState<BackupFileInfo | null>(null);
  const [method, setMethod] = useState<RestoreMethod>("logical");
  const [tools, setTools] = useState<BackupToolInfo[]>([]);
  const [target, setTarget] = useState<"existing" | "new">("existing");
  const [database, setDatabase] = useState(
    d.database ?? session?.info.currentDatabase ?? "",
  );
  const [newDatabase, setNewDatabase] = useState("");
  const [stopOnError, setStopOnError] = useState(true);
  const [singleTx, setSingleTx] = useState(true);
  const [commitEvery, setCommitEvery] = useState(100);
  const [clean, setClean] = useState(false);
  const [jobs, setJobs] = useState(1);
  const [targetPath, setTargetPath] = useState(session?.profile.database ?? "");
  const [replace, setReplace] = useState(false);
  const [pageSize, setPageSize] = useState(8192);
  const [serverFile, setServerFile] = useState("");

  useEffect(() => {
    if (!session || isFileBased(engine)) return;
    vm.detectTools(session.id).then(setTools, () => setTools([]));
  }, [session?.id]);

  useEffect(() => {
    if (!session || !file) return setInfo(null);
    let live = true;
    vm.inspect(session.id, file).then(
      (i) => {
        if (!live) return;
        setInfo(i);
        const usable = i.methods.filter(
          (m) =>
            m === "logical" ||
            m === "sqlite-file" ||
            m === "firebird-service" ||
            toolFor(tools, m)?.compatible,
        );
        setMethod(usable[0] ?? i.methods[0] ?? "logical");
        if (
          i.header?.databases?.length === 1 &&
          !single &&
          (session.databases ?? []).includes(i.header.databases[0])
        )
          setDatabase(i.header.databases[0]);
      },
      () => live && setInfo(null),
    );
    return () => {
      live = false;
    };
  }, [session?.id, file, tools]);

  if (!session) return null;
  const fileMethod =
    method === "sqlite-file" ||
    method === "firebird-service" ||
    method === "gbak";
  const usesServerFile = method === "firebird-service";
  const mismatch =
    info?.header &&
    info.header.engine !== engine &&
    !(isMyFamily(info.header.engine) && isMyFamily(engine));
  const transactional = engine === "postgres" || engine === "sqlite";

  const browse = async (): Promise<void> => {
    const f = await api.invoke("dialog:openFile", {
      filters: [
        {
          name: t("restore.backupFiles"),
          extensions: [
            "sql",
            "gz",
            "backup",
            "dump",
            "fbk",
            "gbk",
            "db",
            "sqlite",
            "sqlite3",
          ],
        },
      ],
    });
    if (f) setFile(f);
  };

  const run = async (): Promise<void> => {
    const replacing = fileMethod
      ? replace || targetPath === session.profile.database
      : false;
    if (
      replacing &&
      !(await confirmDialog(
        t("restore.title"),
        t("restore.confirmReplace", { target: targetPath }),
        true,
      ))
    )
      return;
    if (
      !fileMethod &&
      target === "existing" &&
      !(await confirmDialog(
        t("restore.title"),
        t("restore.confirmInto", {
          target: single ? session.profile.database : database,
        }),
        true,
      ))
    )
      return;
    setBusy(true);
    try {
      const r = await vm.restore(session.id, {
        operationId: opId,
        filePath: usesServerFile ? serverFile : file,
        method,
        database:
          !single && target === "existing" ? database || undefined : undefined,
        createDatabase: !single && target === "new" ? newDatabase : undefined,
        stopOnError,
        singleTransaction: singleTx,
        commitEvery,
        native: { clean, jobs, toolPath: toolFor(tools, method)?.path },
        // Replacing the session's own file was confirmed above.
        file: fileMethod
          ? {
              targetPath,
              replace: replace || targetPath === session.profile.database,
              pageSize,
            }
          : undefined,
      });
      if (r.errors)
        notify.error(
          t("restore.doneErrors", { count: r.statements, errors: r.errors }),
        );
      else notify.success(t("restore.done", { count: r.statements }));
      close();
    } catch (err) {
      notify.error(err);
    } finally {
      setBusy(false);
    }
  };

  const methodTool = toolFor(tools, method);
  const blocked =
    (!usesServerFile && !file) ||
    (usesServerFile && !serverFile) ||
    (!fileMethod && !single && target === "new" && !newDatabase) ||
    (fileMethod && !targetPath) ||
    (!!TOOL_FOR_METHOD[method] && !methodTool?.compatible);

  return (
    <Dialog
      open
      onOpenChange={(v) => !v && !busy && close()}
      title={t("restore.title")}
      width={640}
      footer={
        <>
          <Progress p={progress} />
          {busy ? (
            <Button onClick={() => vm.cancel(session.id, opId)}>
              {t("common.cancel")}
            </Button>
          ) : (
            <Button onClick={close}>{t("common.cancel")}</Button>
          )}
          <Button
            variant="primary"
            loading={busy}
            disabled={blocked}
            onClick={() => void run()}
          >
            {t("restore.start")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 p-4">
        {!usesServerFile && (
          <Field label={t("restore.file")}>
            <div className="flex gap-1.5">
              <Input
                value={file}
                onChange={(e) => setFile(e.target.value)}
                className="font-mono text-xs"
              />
              <Button
                icon={<FolderOpen size={13} />}
                onClick={() => void browse()}
              >
                {t("common.browse")}
              </Button>
            </div>
          </Field>
        )}
        {info && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-sunken px-3 py-2 text-xs text-muted">
            <Badge tone="accent">{t(`restore.kind.${info.kind}`)}</Badge>
            {info.compressed && <Badge>gzip</Badge>}
            <span>{formatBytes(info.size)}</span>
            {info.header && (
              <span>
                {t("restore.detected", {
                  server: info.header.serverLabel,
                  date: new Date(info.header.createdAt).toLocaleString(),
                  databases: info.header.databases.join(", ") || "—",
                })}
              </span>
            )}
            {mismatch && (
              <span className="text-warning">
                {t("restore.engineMismatch", {
                  engine: ENGINE_LABELS[info.header!.engine],
                })}
              </span>
            )}
            {info.needsPsql && (
              <span className="text-warning">{t("restore.needsPsql")}</span>
            )}
          </div>
        )}

        <Field
          label={t("backup.method")}
          hint={
            methodTool?.reason ??
            (TOOL_FOR_METHOD[method] && !methodTool
              ? t("backup.toolMissing", { tool: TOOL_FOR_METHOD[method]![0] })
              : undefined)
          }
        >
          <Select
            value={method}
            onChange={(e) => setMethod(e.target.value as RestoreMethod)}
          >
            {(info?.methods.length
              ? info.methods
              : (["logical"] as RestoreMethod[])
            )
              .concat(
                engine === "firebird" &&
                  session.info.version >= 30000 &&
                  !info?.methods.includes("firebird-service")
                  ? ["firebird-service"]
                  : [],
              )
              .map((m) => {
                const tool = toolFor(tools, m);
                return (
                  <option
                    key={m}
                    value={m}
                    disabled={!!TOOL_FOR_METHOD[m] && !tool?.compatible}
                  >
                    {t(RESTORE_LABELS[m], {
                      tool: tool ? `${tool.tool} ${tool.version}` : m,
                    })}
                  </option>
                );
              })}
          </Select>
        </Field>

        {usesServerFile && (
          <Field
            label={t("restore.serverFile")}
            hint={t("backup.serverPathHint")}
          >
            <Input
              value={serverFile}
              onChange={(e) => setServerFile(e.target.value)}
              className="font-mono text-xs"
            />
          </Field>
        )}

        {!fileMethod && !single && (
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="radio"
                checked={target === "existing"}
                onChange={() => setTarget("existing")}
              />
              {t("restore.existing")}
            </label>
            <Select
              value={database}
              disabled={target !== "existing"}
              onChange={(e) => setDatabase(e.target.value)}
            >
              <option value="">{t("restore.asInFile")}</option>
              {(session.databases ?? []).map((db) => (
                <option key={db}>{db}</option>
              ))}
            </Select>
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="radio"
                checked={target === "new"}
                onChange={() => setTarget("new")}
              />
              {t("restore.newDatabase")}
            </label>
            <Input
              value={newDatabase}
              disabled={target !== "new"}
              onChange={(e) => setNewDatabase(e.target.value)}
            />
          </div>
        )}

        {fileMethod && (
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <Field
              label={t("restore.targetPath")}
              hint={
                engine === "firebird" ? t("restore.targetPathHint") : undefined
              }
            >
              <Input
                value={targetPath}
                onChange={(e) => setTargetPath(e.target.value)}
                className="font-mono text-xs"
              />
            </Field>
            {engine === "firebird" && (
              <Field label={t("restore.pageSize")}>
                <Select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                >
                  {[4096, 8192, 16384, 32768].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {engine === "firebird" && (
              <Checkbox
                checked={replace}
                onChange={setReplace}
                label={t("restore.replace")}
              />
            )}
          </div>
        )}

        {!fileMethod && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Checkbox
              checked={stopOnError}
              onChange={setStopOnError}
              label={t("import.stopOnError")}
            />
            {(transactional ||
              method === "pg_restore" ||
              method === "psql") && (
              <Checkbox
                checked={singleTx && stopOnError}
                disabled={!stopOnError || (method === "pg_restore" && jobs > 1)}
                onChange={setSingleTx}
                label={t("restore.singleTransaction")}
              />
            )}
            {method === "logical" && !transactional && (
              <Field label={t("restore.commitEvery")}>
                <Input
                  type="number"
                  min={1}
                  value={commitEvery}
                  onChange={(e) => setCommitEvery(Number(e.target.value) || 1)}
                />
              </Field>
            )}
            {method === "pg_restore" && (
              <Checkbox
                checked={clean}
                onChange={setClean}
                label={t("restore.clean")}
              />
            )}
            {method === "pg_restore" && (
              <Field label={t("restore.jobs")}>
                <Input
                  type="number"
                  min={1}
                  max={16}
                  value={jobs}
                  onChange={(e) =>
                    setJobs(Math.max(1, Number(e.target.value) || 1))
                  }
                />
              </Field>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

const isMyFamily = (e: DbEngine): boolean => e === "mysql" || e === "mariadb";
