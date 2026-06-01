import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";

import { ActionButton } from "@/components/ActionButton";
import { withTimeout } from "@/services/async/withTimeout";
import { BackendFaceEngine } from "@/services/face/backendFaceEngine";
import { OnDeviceFaceEngine } from "@/services/face/onDeviceFaceEngine";
import { DEFAULT_FACE_API_BASE_URL, getDeviceBackendHint, normalizeApiBaseUrl } from "@/services/config/faceBackend";
import { getEngineSetting, getFaceDatabase, setEngineSetting } from "@/services/storage/database";
import { syncAttendanceQueue } from "@/services/sync/syncService";

const BACKEND_URL_SETTING = "face_api_base_url";

export default function Index() {
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_FACE_API_BASE_URL);
  const [status, setStatus] = useState("Ready");
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      await getFaceDatabase();
      const storedUrl = await getEngineSetting(BACKEND_URL_SETTING);

      if (mounted && storedUrl) {
        setApiBaseUrl(storedUrl);
      }
    }

    bootstrap().catch((error) => {
      if (mounted) {
        setStatus(error instanceof Error ? error.message : "Database setup failed");
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
  }

  async function checkHealth() {
    setIsBusy(true);
    setStatus("Checking backend...");

    try {
      await saveBackendUrl();
      const engine = new BackendFaceEngine({ apiBaseUrl });
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
      await saveBackendUrl();
      const summary = await syncAttendanceQueue(apiBaseUrl);

      if (!summary.online) {
        setStatus("No internet/backend path available. Queue kept locally.");
      } else {
        setStatus(`Sync complete: ${summary.synced}/${summary.attempted} synced, ${summary.failed} failed`);
      }
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
    await saveBackendUrl();
    router.push({ pathname, params: { apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl) } } as never);
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>DSEAS Face Engine</Text>
        <Text style={styles.title}>Offline-first attendance spine</Text>
        <Text style={styles.subtitle}>
          This app now mirrors the backend workflow: capture, prepare 320x320 face images, enroll, recognize, store
          attendance locally, and sync when the backend/cloud path is available.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Face backend API URL</Text>
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
        <View style={styles.row}>
          <ActionButton disabled={isBusy} onPress={checkHealth} title="Check Backend" />
          <ActionButton disabled={isBusy} onPress={runSync} title="Sync Queue" variant="secondary" />
        </View>
      </View>

      <View style={styles.grid}>
        <ActionButton disabled={isBusy} onPress={() => openRoute("/detect")} title="Detect Faces" variant="secondary" />
        <ActionButton disabled={isBusy} onPress={() => openRoute("/recognize")} title="Recognize & Mark" />
        <ActionButton disabled={isBusy} onPress={() => openRoute("/enroll")} title="Enroll Face" variant="secondary" />
        <ActionButton disabled={isBusy} onPress={() => openRoute("/logs")} title="View Logs" variant="secondary" />
        <ActionButton
          disabled={isBusy}
          onPress={() => {
            Alert.alert(
              "On-device engine",
              "This checks the bundled SCRFD detector and EdgeFace embedder through ONNX Runtime. It requires a development/native build, not Expo Go.",
              [
                { text: "Cancel", style: "cancel" },
                { text: "Check", onPress: checkOnDeviceEngine },
              ],
            );
          }}
          title="On-device Engine Status"
          variant="secondary"
        />
      </View>

      <View style={styles.statusBox}>
        <Text style={styles.statusTitle}>Status</Text>
        <Text style={styles.statusText}>{status}</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 22,
    gap: 12,
    padding: 18,
    shadowColor: "#0F172A",
    shadowOpacity: 0.08,
    shadowRadius: 18,
  },
  container: {
    backgroundColor: "#F7FAFF",
    gap: 18,
    minHeight: "100%",
    padding: 20,
  },
  eyebrow: {
    color: "#60A5FA",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  grid: {
    gap: 12,
  },
  hero: {
    backgroundColor: "#0F172A",
    borderRadius: 26,
    gap: 10,
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
    borderRadius: 14,
    borderWidth: 1,
    color: "#0F172A",
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  label: {
    color: "#0F172A",
    fontSize: 14,
    fontWeight: "800",
  },
  row: {
    flexDirection: "row",
    gap: 10,
  },
  statusBox: {
    backgroundColor: "#EAF2FF",
    borderRadius: 18,
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
    fontSize: 30,
    fontWeight: "900",
    lineHeight: 36,
  },
});
