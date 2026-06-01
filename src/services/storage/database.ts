import * as SQLite from "expo-sqlite";

export type LocalFaceRecord = {
  person_id: string;
  name: string;
  embedding_json: string | null;
  created_at: string;
  updated_at: string;
  synced: number;
};

export type LocalAttendanceRecord = {
  id: string;
  person_id: string;
  name: string;
  confidence: number;
  liveness_verified: number;
  location: string;
  timestamp: string;
  synced: number;
  sync_attempts: number;
  last_sync_at: string | null;
  cloud_id: string | null;
  source: string;
};

export type NewAttendanceRecord = {
  person_id: string;
  name: string;
  confidence: number;
  liveness_verified: boolean;
  location: string;
  timestamp?: string;
  synced?: boolean;
  cloud_id?: string | null;
  source?: "backend" | "local" | "manual";
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let faceEmbeddingDatabaseCache:
  | {
      loadedAt: number;
      value: Record<string, { name: string; embeddings: number[][] }>;
    }
  | null = null;

const FACE_EMBEDDING_CACHE_TTL_MS = 30000;

export async function getFaceDatabase() {
  if (!databasePromise) {
    databasePromise = SQLite.openDatabaseAsync("dseas_face_engine.db").then(async (database) => {
      await database.execAsync(`
        PRAGMA journal_mode = WAL;

        CREATE TABLE IF NOT EXISTS local_faces (
          person_id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          embedding_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          synced INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS attendance_queue (
          id TEXT PRIMARY KEY NOT NULL,
          person_id TEXT NOT NULL,
          name TEXT NOT NULL,
          confidence REAL NOT NULL,
          liveness_verified INTEGER NOT NULL,
          location TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          synced INTEGER NOT NULL DEFAULT 0,
          sync_attempts INTEGER NOT NULL DEFAULT 0,
          last_sync_at TEXT,
          cloud_id TEXT,
          source TEXT NOT NULL DEFAULT 'local'
        );

        CREATE TABLE IF NOT EXISTS engine_settings (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
      `);

      return database;
    });
  }

  return databasePromise;
}

export async function saveLocalFaceMetadata(
  personId: string,
  name: string,
  embedding?: number[] | null,
  options: { synced?: boolean } = {},
) {
  const database = await getFaceDatabase();
  const timestamp = new Date().toISOString();

  await database.runAsync(
    `
      INSERT INTO local_faces (person_id, name, embedding_json, created_at, updated_at, synced)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(person_id) DO UPDATE SET
        name = excluded.name,
        embedding_json = COALESCE(excluded.embedding_json, local_faces.embedding_json),
        updated_at = excluded.updated_at,
        synced = excluded.synced;
    `,
    personId,
    name,
    embedding ? JSON.stringify(embedding) : null,
    timestamp,
    timestamp,
    options.synced ? 1 : 0,
  );

  faceEmbeddingDatabaseCache = null;
}

export async function getLocalFaces() {
  const database = await getFaceDatabase();

  return database.getAllAsync<LocalFaceRecord>("SELECT * FROM local_faces ORDER BY updated_at DESC");
}

export async function getLocalFaceEmbeddingDatabase() {
  if (faceEmbeddingDatabaseCache && Date.now() - faceEmbeddingDatabaseCache.loadedAt < FACE_EMBEDDING_CACHE_TTL_MS) {
    return faceEmbeddingDatabaseCache.value;
  }

  const faces = await getLocalFaces();
  const database: Record<string, { name: string; embeddings: number[][] }> = {};

  for (const face of faces) {
    if (!face.embedding_json) {
      continue;
    }

    try {
      const embedding = JSON.parse(face.embedding_json) as number[];
      database[face.person_id] = {
        name: face.name,
        embeddings: [embedding],
      };
    } catch {
      // Ignore malformed local records so one bad row cannot break offline recognition.
    }
  }

  faceEmbeddingDatabaseCache = {
    loadedAt: Date.now(),
    value: database,
  };

  return database;
}

export async function saveAttendanceRecord(record: NewAttendanceRecord) {
  const database = await getFaceDatabase();
  const timestamp = record.timestamp ?? new Date().toISOString();
  const id = `${record.source ?? "local"}-${timestamp}-${Math.random().toString(16).slice(2)}`;

  await database.runAsync(
    `
      INSERT INTO attendance_queue (
        id,
        person_id,
        name,
        confidence,
        liveness_verified,
        location,
        timestamp,
        synced,
        sync_attempts,
        last_sync_at,
        cloud_id,
        source
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?);
    `,
    id,
    record.person_id,
    record.name,
    record.confidence,
    record.liveness_verified ? 1 : 0,
    record.location,
    timestamp,
    record.synced ? 1 : 0,
    record.synced ? timestamp : null,
    record.cloud_id ?? null,
    record.source ?? "local",
  );

  return id;
}

export async function getAttendanceRecords(limit = 100) {
  const database = await getFaceDatabase();

  return database.getAllAsync<LocalAttendanceRecord>(
    "SELECT * FROM attendance_queue ORDER BY timestamp DESC LIMIT ?",
    limit,
  );
}

export async function getUnsyncedAttendanceRecords(limit = 50) {
  const database = await getFaceDatabase();

  return database.getAllAsync<LocalAttendanceRecord>(
    "SELECT * FROM attendance_queue WHERE synced = 0 ORDER BY timestamp ASC LIMIT ?",
    limit,
  );
}

export async function markAttendanceSynced(id: string, cloudId?: string | null) {
  const database = await getFaceDatabase();

  await database.runAsync(
    "UPDATE attendance_queue SET synced = 1, last_sync_at = ?, cloud_id = COALESCE(?, cloud_id) WHERE id = ?",
    new Date().toISOString(),
    cloudId ?? null,
    id,
  );
}

export async function incrementAttendanceSyncAttempt(id: string) {
  const database = await getFaceDatabase();

  await database.runAsync(
    "UPDATE attendance_queue SET sync_attempts = sync_attempts + 1, last_sync_at = ? WHERE id = ?",
    new Date().toISOString(),
    id,
  );
}

export async function setEngineSetting(key: string, value: string) {
  const database = await getFaceDatabase();

  await database.runAsync(
    `
      INSERT INTO engine_settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `,
    key,
    value,
  );
}

export async function getEngineSetting(key: string) {
  const database = await getFaceDatabase();
  const row = await database.getFirstAsync<{ value: string }>("SELECT value FROM engine_settings WHERE key = ?", key);

  return row?.value ?? null;
}
