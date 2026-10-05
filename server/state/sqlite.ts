import { chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { Store } from "../domain/types.js";

const schemaVersion = 1;
const entityKinds = ["projects", "conversations", "skills", "automations", "goals", "approvals", "memories", "memoryCandidates", "attachments"] as const;
type EntityKind = typeof entityKinds[number];
type StoredEntity = { id: string };

export function openSqliteState(filePath: string) {
  const db = new DatabaseSync(filePath, { timeout: 5_000 });
  try {
    chmodSync(filePath, 0o600);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    migrateSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const owner = randomUUID();
  const host = os.hostname();
  const pid = process.pid;
  let leaseValid = true;
  let closed = false;
  try { acquireLease(); }
  catch (error) { db.close(); throw error; }
  const heartbeat = setInterval(() => {
    try { renewLease(); }
    catch (error) {
      leaseValid = false;
      console.error("SQLite runtime lease lost; further state writes are disabled", error);
    }
  }, 5_000);
  heartbeat.unref();
  const onExit = () => { close(); };
  process.once("exit", onExit);

  function loadSnapshot(): Store | undefined {
    const initialized = db.prepare("SELECT value FROM metadata WHERE key = ?").get("initialized") as { value: string } | undefined;
    if (!initialized) return undefined;
    const settingsRow = db.prepare("SELECT value FROM metadata WHERE key = ?").get("settings") as { value: string } | undefined;
    const attentionRow = db.prepare("SELECT value FROM metadata WHERE key = ?").get("attention") as { value: string } | undefined;
    const entities: Record<EntityKind, StoredEntity[]> = {
      projects: [], conversations: [], skills: [], automations: [],
      goals: [], approvals: [], memories: [], memoryCandidates: [], attachments: []
    };
    const rows = db.prepare("SELECT kind, payload FROM entities ORDER BY kind, id").all() as Array<{ kind: EntityKind; payload: string }>;
    for (const row of rows) {
      if (!(row.kind in entities)) throw new Error(`Unknown stored entity kind: ${row.kind}`);
      entities[row.kind].push(JSON.parse(row.payload) as StoredEntity);
    }
    return {
      settings: settingsRow ? JSON.parse(settingsRow.value) as Store["settings"] : undefined,
      attention: attentionRow ? JSON.parse(attentionRow.value) as Store["attention"] : undefined,
      projects: entities.projects as Store["projects"],
      conversations: entities.conversations as Store["conversations"],
      skills: entities.skills as Store["skills"],
      automations: entities.automations as Store["automations"],
      goals: entities.goals as Store["goals"],
      approvals: entities.approvals as Store["approvals"],
      memories: entities.memories as Store["memories"],
      memoryCandidates: entities.memoryCandidates as Store["memoryCandidates"],
      attachments: entities.attachments as Store["attachments"]
    };
  }

  function replaceSnapshot(store: Store) {
    if (closed || !leaseValid) throw new Error("SQLite runtime lease is unavailable");
    transaction(db, () => {
      const lease = db.prepare("SELECT owner FROM runtime_lease WHERE name = ?").get("server") as { owner: string } | undefined;
      if (lease?.owner !== owner) {
        leaseValid = false;
        throw new Error("SQLite runtime lease was taken by another process");
      }
      const upsert = db.prepare("INSERT INTO entities (kind, id, payload) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET payload = excluded.payload WHERE entities.payload <> excluded.payload");
      const remove = db.prepare("DELETE FROM entities WHERE kind = ? AND id = ?");
      const existingRows = db.prepare("SELECT kind, id FROM entities").all() as Array<{ kind: string; id: string }>;
      const incoming = new Set<string>();
      for (const kind of entityKinds) {
        for (const item of (store[kind] || []) as StoredEntity[]) {
          if (!item || typeof item.id !== "string" || !item.id) throw new Error(`Invalid ${kind} entity ID`);
          incoming.add(`${kind}\0${item.id}`);
          upsert.run(kind, item.id, JSON.stringify(item));
        }
      }
      for (const row of existingRows) {
        if (!incoming.has(`${row.kind}\0${row.id}`)) remove.run(row.kind, row.id);
      }
      const setMeta = db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      setMeta.run("settings", JSON.stringify(store.settings || {}));
      setMeta.run("attention", JSON.stringify(store.attention || { mode: "important", readIds: [] }));
      setMeta.run("initialized", "1");
    });
  }

  function acquireLease() {
    transaction(db, () => {
      const existing = db.prepare("SELECT owner, pid, host, expires_at FROM runtime_lease WHERE name = ?").get("server") as {
        owner: string; pid: number; host: string; expires_at: number;
      } | undefined;
      // A paused process may miss heartbeats while still executing tools. On the
      // same host, a live PID keeps ownership even when the timestamp expired.
      if (existing && (existing.host === host ? processIsAlive(existing.pid) : existing.expires_at > Date.now())) {
        throw new Error(`SuperCodex is already running for this data directory (PID ${existing.pid})`);
      }
      db.prepare("INSERT INTO runtime_lease (name, owner, pid, host, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, pid = excluded.pid, host = excluded.host, expires_at = excluded.expires_at")
        .run("server", owner, pid, host, Date.now() + 15_000);
    });
  }

  function renewLease() {
    if (closed || !leaseValid) return;
    const result = db.prepare("UPDATE runtime_lease SET expires_at = ? WHERE name = ? AND owner = ?").run(Date.now() + 15_000, "server", owner);
    if (result.changes !== 1) throw new Error("SQLite runtime lease renewal failed");
  }

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    process.off("exit", onExit);
    try { db.prepare("DELETE FROM runtime_lease WHERE name = ? AND owner = ?").run("server", owner); }
    finally { db.close(); }
  }

  return { loadSnapshot, replaceSnapshot, close };
}

function migrateSchema(db: DatabaseSync) {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version > schemaVersion) throw new Error(`Unsupported state database version: ${row.user_version}`);
  if (row.user_version === schemaVersion) return;
  transaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (kind, id)) STRICT;
      CREATE TABLE IF NOT EXISTS runtime_lease (name TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL, expires_at INTEGER NOT NULL) STRICT;
      PRAGMA user_version = 1;
    `);
  });
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function processIsAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
