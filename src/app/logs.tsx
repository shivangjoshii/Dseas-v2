import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";

import { ActionButton } from "@/components/ActionButton";
import { DEFAULT_FACE_API_BASE_URL } from "@/services/config/faceBackend";
import { BackendFaceEngine } from "@/services/face/backendFaceEngine";
import type { BackendAttendanceLog } from "@/services/face/types";
import { getAttendanceRecords, type LocalAttendanceRecord } from "@/services/storage/database";
import { syncAttendanceQueue } from "@/services/sync/syncService";

export default function LogsScreen() {
  const params = useLocalSearchParams<{ apiBaseUrl?: string }>();
  const apiBaseUrl = params.apiBaseUrl ?? DEFAULT_FACE_API_BASE_URL;
  const [localLogs, setLocalLogs] = useState<LocalAttendanceRecord[]>([]);
  const [backendLogs, setBackendLogs] = useState<BackendAttendanceLog[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState("Local buffer is ready.");

  const refreshLogs = useCallback(async () => {
    setIsLoading(true);

    try {
      const [localRecords, remoteRecords] = await Promise.all([
        getAttendanceRecords(100),
        new BackendFaceEngine({ apiBaseUrl }).getAttendanceLogs(50).catch(() => []),
      ]);

      setLocalLogs(localRecords);
      setBackendLogs(remoteRecords);
      setStatus(`Loaded ${localRecords.length} local and ${remoteRecords.length} backend records.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load logs");
    } finally {
      setIsLoading(false);
    }
  }, [apiBaseUrl]);

  async function syncAndRefresh() {
    setIsLoading(true);
    setStatus("Syncing unsynced local records...");

    try {
      const summary = await syncAttendanceQueue(apiBaseUrl);
      setStatus(
        summary.online
          ? `Sync complete: ${summary.synced}/${summary.attempted} synced, ${summary.failed} failed.`
          : "Offline. Records remain queued locally.",
      );
      await refreshLogs();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Sync failed");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) {
        refreshLogs();
      }
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refreshLogs]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Attendance Logs</Text>
        <Text style={styles.subtitle}>Local queue first, backend logs second. Unsynced records stay buffered.</Text>
      </View>

      <View style={styles.controls}>
        <ActionButton disabled={isLoading} onPress={refreshLogs} title="Refresh" />
        <ActionButton disabled={isLoading} onPress={syncAndRefresh} title="Sync Queue" variant="secondary" />
      </View>

      <View style={styles.statusBox}>
        {isLoading ? <ActivityIndicator color="#1677FF" /> : null}
        <Text style={styles.statusText}>{status}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Local Attendance Buffer</Text>
        {localLogs.length === 0 ? (
          <Text style={styles.muted}>No local attendance records.</Text>
        ) : (
          localLogs.map((record) => (
            <View key={record.id} style={styles.logRow}>
              <Text style={styles.logName}>{record.name}</Text>
              <Text style={styles.logMeta}>ID: {record.person_id}</Text>
              <Text style={styles.logMeta}>Confidence: {(record.confidence * 100).toFixed(1)}%</Text>
              <Text style={styles.logMeta}>Synced: {record.synced ? "yes" : "no"}</Text>
              <Text style={styles.logMeta}>Source: {record.source}</Text>
              <Text style={styles.logMeta}>{record.timestamp}</Text>
            </View>
          ))
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Backend Logs</Text>
        {backendLogs.length === 0 ? (
          <Text style={styles.muted}>No backend logs loaded.</Text>
        ) : (
          backendLogs.map((record) => (
            <View key={`${record.id}-${record.timestamp}`} style={styles.logRow}>
              <Text style={styles.logName}>{record.name}</Text>
              <Text style={styles.logMeta}>ID: {record.person_id}</Text>
              <Text style={styles.logMeta}>Confidence: {(record.confidence * 100).toFixed(1)}%</Text>
              <Text style={styles.logMeta}>Location: {record.location}</Text>
              <Text style={styles.logMeta}>{record.timestamp}</Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 22,
    gap: 12,
    padding: 16,
  },
  container: {
    backgroundColor: "#F7FAFF",
    gap: 16,
    padding: 18,
  },
  controls: {
    gap: 10,
  },
  header: {
    backgroundColor: "#0F172A",
    borderRadius: 26,
    gap: 8,
    padding: 22,
  },
  logMeta: {
    color: "#64748B",
    fontSize: 13,
  },
  logName: {
    color: "#0F172A",
    fontSize: 17,
    fontWeight: "900",
  },
  logRow: {
    backgroundColor: "#F8FAFC",
    borderRadius: 16,
    gap: 4,
    padding: 14,
  },
  muted: {
    color: "#64748B",
    fontSize: 14,
  },
  sectionTitle: {
    color: "#0F172A",
    fontSize: 16,
    fontWeight: "900",
  },
  statusBox: {
    alignItems: "center",
    backgroundColor: "#EAF2FF",
    borderRadius: 18,
    flexDirection: "row",
    gap: 10,
    padding: 14,
  },
  statusText: {
    color: "#124A9C",
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  subtitle: {
    color: "#CBD5E1",
    fontSize: 15,
    lineHeight: 22,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 30,
    fontWeight: "900",
  },
});
