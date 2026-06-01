import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";

import { ActionButton } from "@/components/ActionButton";
import { AppBottomNav } from "@/components/AppBottomNav";
import { withTimeout } from "@/services/async/withTimeout";
import { DEFAULT_FACE_API_BASE_URL, getDeviceBackendHint, normalizeApiBaseUrl } from "@/services/config/faceBackend";
import { BackendFaceEngine } from "@/services/face/backendFaceEngine";
import { OnDeviceFaceEngine } from "@/services/face/onDeviceFaceEngine";
import { getEngineSetting, getFaceDatabase, getUnsyncedAttendanceRecords, setEngineSetting } from "@/services/storage/database";
import { syncAttendanceQueue } from "@/services/sync/syncService";

const BACKEND_URL_SETTING = "face_api_base_url";

export default function SettingsScreen() {
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_FACE_API_BASE_URL);
  const [status, setStatus] = useState("Control center ready");
  const [queueStatus, setQueueStatus] = useState("Checking local queue...");
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      await getFaceDatabase();
      const [storedUrl, pendingRecords] = await Promise.all([
        getEngineSetting(BACKEND_URL_SETTING),
        getUnsyncedAttendanceRecords(50),
      ]);

      if (!mounted) {
        return;
      }

      if (storedUrl) {
        setApiBaseUrl(storedUrl);
      }

      setQueueStatus(
        pendingRecords.length > 0
          ? `${pendingRecords.length} local record${pendingRecords.length === 1 ? "" : "s"} waiting for sync`
          : "No pending local records",
      );
    }

    bootstrap().catch((error) => {
      if (mounted) {
        setStatus(error instanceof Error ? error.message : "Settings setup failed");
        setQueueStatus("Queue status unavailable");
      }
    });

    return () => {
      mounted = false;
    };
  }, []);

  async function saveBackendUrl() {
    const normalized = normalizeApiBaseUrl(apiBaseUrl);
    setApiBaseUrl(normalized);
    await setEngineSetting(BACKEND_URL_SETTING, normalized);
    setStatus("Backend URL saved");

    return normalized;
  }

  async function checkHealth() {
    setIsBusy(true);
    setStatus("Checking backend...");

    try {
      const normalized = await saveBackendUrl();
      const engine = new BackendFaceEngine({ apiBaseUrl: normalized });
      const health = await engine.health();
      setStatus(`Backend online: ${health.status} v${health.version}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Backend health check failed");
    } finally {
      setIsBusy(false);
    }
  }

  async function runSync() {
    setIsBusy(true);
    setStatus("Syncing local attendance queue...");

    try {
      const normalized = await saveBackendUrl();
      const summary = await syncAttendanceQueue(normalized);

      if (!summary.online) {
        setStatus("No internet/backend path available. Queue kept locally.");
      } else {
        setStatus(`Sync complete: ${summary.synced}/${summary.attempted} synced, ${summary.failed} failed`);
      }

      const pendingRecords = await getUnsyncedAttendanceRecords(50);
      setQueueStatus(
        pendingRecords.length > 0
          ? `${pendingRecords.length} local record${pendingRecords.length === 1 ? "" : "s"} still waiting`
          : "No pending local records",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Sync failed");
    } finally {
      setIsBusy(false);
    }
  }

  async function checkOnDeviceEngine() {
    setIsBusy(true);
    setStatus("Loading bundled ONNX models...");

    try {
      const health = await withTimeout(
        new OnDeviceFaceEngine().health(),
        25000,
        "On-device ONNX model loading timed out",
      );
      setStatus(`On-device engine ready: ${health.version}`);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `On-device engine not ready in this build: ${error.message}`
          : "On-device engine check failed",
      );
    } finally {
      setIsBusy(false);
    }
  }

  async function openRoute(pathname: "/detect" | "/recognize" | "/enroll" | "/logs") {
    const normalized = await saveBackendUrl();
    router.push({ pathname, params: { apiBaseUrl: normalized } } as never);
  }

  return (
    <View style={styles.screen}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.container}>
        <View style={styles.appBar}>
          <Text style={styles.appBarTitle}>DSEAS</Text>
        </View>

        <View style={styles.headerCard}>
          <Text style={styles.eyebrow}>Settings</Text>
          <Text style={styles.title}>System Control Center</Text>
          <Text style={styles.subtitle}>
            Manage backend connectivity, local ONNX engine checks, detection tools, logs, and queue sync.
          </Text>
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardIcon}>🌐</Text>
            <View style={styles.cardTitleBlock}>
              <Text style={styles.cardTitle}>Backend</Text>
              <Text style={styles.cardSubtitle}>Flask/API endpoint used for server workflows.</Text>
            </View>
          </View>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onChangeText={setApiBaseUrl}
            placeholder="http://YOUR_IP:5000/api/v1"
            style={styles.input}
            value={apiBaseUrl}
          />
          <Text style={styles.hint}>{getDeviceBackendHint()}</Text>
          <View style={styles.actionGrid}>
            <ActionButton disabled={isBusy} onPress={checkHealth} title="Check Backend" />
            <ActionButton disabled={isBusy} onPress={saveBackendUrl} title="Save Backend" variant="secondary" />
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardIcon}>🧠</Text>
            <View style={styles.cardTitleBlock}>
              <Text style={styles.cardTitle}>On-device Engine</Text>
              <Text style={styles.cardSubtitle}>Bundled SCRFD detector and EdgeFace recognizer.</Text>
            </View>
          </View>
          <ActionButton
            disabled={isBusy}
            onPress={() => {
              Alert.alert(
                "On-device engine",
                "This checks the bundled ONNX models through native ONNX Runtime. It requires this development/native build, not Expo Go.",
                [
                  { text: "Cancel", style: "cancel" },
                  { text: "Check", onPress: checkOnDeviceEngine },
                ],
              );
            }}
            title="Check On-device Engine Status"
            variant="secondary"
          />
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardIcon}>🧭</Text>
            <View style={styles.cardTitleBlock}>
              <Text style={styles.cardTitle}>Tools</Text>
              <Text style={styles.cardSubtitle}>Open diagnostics and operational screens.</Text>
            </View>
          </View>
          <View style={styles.actionGrid}>
            <ActionButton disabled={isBusy} onPress={() => openRoute("/detect")} title="Detect Faces" />
            <ActionButton disabled={isBusy} onPress={() => openRoute("/logs")} title="View Logs" variant="secondary" />
            <ActionButton
              disabled={isBusy}
              onPress={() => openRoute("/recognize")}
              title="Recognition & Mark"
              variant="secondary"
            />
            <ActionButton disabled={isBusy} onPress={() => openRoute("/enroll")} title="Enroll Face" variant="secondary" />
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardIcon}>🔁</Text>
            <View style={styles.cardTitleBlock}>
              <Text style={styles.cardTitle}>Queue & Sync</Text>
              <Text style={styles.cardSubtitle}>{queueStatus}</Text>
            </View>
          </View>
          <ActionButton disabled={isBusy} onPress={runSync} title="Sync Local Queue" />
        </View>

        <View style={styles.statusBox}>
          <Text style={styles.statusTitle}>Latest Status</Text>
          <Text style={styles.statusText}>{status}</Text>
        </View>
      </ScrollView>

      <AppBottomNav active="settings" apiBaseUrl={normalizeApiBaseUrl(apiBaseUrl)} />
    </View>
  );
}

const styles = StyleSheet.create({
  actionGrid: {
    gap: 10,
  },
  appBar: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.56)",
    borderColor: "rgba(226,232,240,0.82)",
    borderRadius: 24,
    borderWidth: 1,
    height: 56,
    justifyContent: "center",
  },
  appBarTitle: {
    color: "#0F172A",
    fontSize: 18,
    fontWeight: "900",
    letterSpacing: 3,
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 26,
    borderWidth: 1,
    gap: 14,
    padding: 18,
  },
  cardHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  cardIcon: {
    fontSize: 28,
  },
  cardSubtitle: {
    color: "#64748B",
    fontSize: 13,
    lineHeight: 19,
  },
  cardTitle: {
    color: "#0F172A",
    fontSize: 17,
    fontWeight: "900",
  },
  cardTitleBlock: {
    flex: 1,
    gap: 3,
  },
  container: {
    gap: 16,
    padding: 18,
    paddingBottom: 124,
  },
  eyebrow: {
    color: "#93C5FD",
    fontSize: 13,
    fontWeight: "900",
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  headerCard: {
    backgroundColor: "#0F172A",
    borderRadius: 30,
    gap: 8,
    padding: 22,
  },
  hint: {
    color: "#64748B",
    fontSize: 12,
    lineHeight: 18,
  },
  input: {
    backgroundColor: "#F8FAFC",
    borderColor: "#D8E2F0",
    borderRadius: 16,
    borderWidth: 1,
    color: "#0F172A",
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  screen: {
    backgroundColor: "#F7FAFF",
    flex: 1,
  },
  statusBox: {
    backgroundColor: "#EAF2FF",
    borderRadius: 22,
    gap: 6,
    padding: 16,
  },
  statusText: {
    color: "#124A9C",
    fontSize: 14,
    lineHeight: 20,
  },
  statusTitle: {
    color: "#124A9C",
    fontSize: 13,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  subtitle: {
    color: "#CBD5E1",
    fontSize: 15,
    lineHeight: 22,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 31,
    fontWeight: "900",
    letterSpacing: -0.8,
    lineHeight: 37,
  },
});
