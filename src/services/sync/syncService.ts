import * as Network from "expo-network";

import { BackendFaceEngine } from "@/services/face/backendFaceEngine";
import {
  getUnsyncedAttendanceRecords,
  incrementAttendanceSyncAttempt,
  markAttendanceSynced,
} from "@/services/storage/database";

export type SyncSummary = {
  online: boolean;
  attempted: number;
  synced: number;
  failed: number;
};

export async function isNetworkUsable() {
  const state = await Network.getNetworkStateAsync();

  return Boolean(state.isConnected && state.isInternetReachable !== false);
}

export async function syncAttendanceQueue(apiBaseUrl: string): Promise<SyncSummary> {
  const online = await isNetworkUsable();

  if (!online) {
    return {
      online: false,
      attempted: 0,
      synced: 0,
      failed: 0,
    };
  }

  const records = await getUnsyncedAttendanceRecords();
  const engine = new BackendFaceEngine({ apiBaseUrl });
  let synced = 0;
  let failed = 0;

  for (const record of records) {
    try {
      await engine.logAttendance({
        person_id: record.person_id,
        name: record.name,
        confidence: record.confidence,
        liveness_verified: Boolean(record.liveness_verified),
        location: record.location,
      });
      await markAttendanceSynced(record.id, `backend:${record.id}`);
      synced += 1;
    } catch {
      await incrementAttendanceSyncAttempt(record.id);
      failed += 1;
    }
  }

  return {
    online: true,
    attempted: records.length,
    synced,
    failed,
  };
}
