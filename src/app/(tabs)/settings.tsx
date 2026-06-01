import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";

import { ActionButton } from "@/components/ActionButton";
import { AppIcon } from "@/components/AppIcon";
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

    if (pathname === "/enroll") {
      router.navigate({ pathname, params: { apiBaseUrl: normalized } } as never);
      return;
    }

    router.push({ pathname, params: { apiBaseUrl: normalized } } as never);
  }

  return (
    <View style={styles.screen}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.container}>
        <View style={styles.appBar}>
          <View style={styles.appBarIcon}>
            <AppIcon android="settings" color="#1677FF" fallback="S" ios="gearshape.fill" size={23} />
          </View>
          <Text style={styles.appBarTitle}>Settings</Text>
          <View style={styles.appBarGhost} />
        </View>

        <View style={styles.hero}>
          <Text style={styles.eyebrow}>Control Center</Text>
          <Text style={styles.title}>DSEAS Operations</Text>
          <Text style={styles.subtitle}>Backend, local AI engine, diagnostics, logs and queue sync in one secure hub.</Text>
        </View>

        <View style={styles.statusRibbon}>
          <AppIcon android="verified_user" color="#22C55E" fallback="OK" ios="checkmark.shield.fill" size={22} />
          <View style={styles.statusRibbonCopy}>
            <Text style={styles.statusRibbonTitle}>Latest Status</Text>
            <Text style={styles.statusRibbonText}>{status}</Text>
          </View>
        </View>

        <View style={[styles.panel, styles.backendPanel]}>
          <SettingHeader
            android="dns"
            ios="server.rack"
            subtitle="Server workflows and cloud bridge"
            title="Backend Endpoint"
          />
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

        <View style={styles.featureGrid}>
          <FeatureTile
            android="psychology"
            disabled={isBusy}
            ios="brain.head.profile"
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
            title="Engine Status"
          />
          <FeatureTile
            android="face"
            disabled={isBusy}
            ios="faceid"
            onPress={() => openRoute("/detect")}
            title="Detect Faces"
          />
          <FeatureTile
            android="history"
            disabled={isBusy}
            ios="clock.arrow.circlepath"
            onPress={() => openRoute("/logs")}
            title="View Logs"
          />
          <FeatureTile
            android="person_search"
            disabled={isBusy}
            ios="person.crop.circle.badge.checkmark"
            onPress={() => openRoute("/recognize")}
            title="Recognize"
          />
        </View>

        <View style={styles.panel}>
          <SettingHeader android="sync" ios="arrow.triangle.2.circlepath" subtitle={queueStatus} title="Queue & Sync" />
          <ActionButton disabled={isBusy} onPress={runSync} title="Sync Local Queue" />
        </View>
      </ScrollView>
    </View>
  );
}

function SettingHeader({
  android,
  ios,
  subtitle,
  title,
}: {
  android: string;
  ios: string;
  subtitle: string;
  title: string;
}) {
  return (
    <View style={styles.settingHeader}>
      <View style={styles.settingIcon}>
        <AppIcon android={android} color="#1677FF" fallback="I" ios={ios} size={24} />
      </View>
      <View style={styles.settingHeaderCopy}>
        <Text style={styles.settingTitle}>{title}</Text>
        <Text style={styles.settingSubtitle}>{subtitle}</Text>
      </View>
    </View>
  );
}

function FeatureTile({
  android,
  disabled,
  ios,
  onPress,
  title,
}: {
  android: string;
  disabled?: boolean;
  ios: string;
  onPress: () => void;
  title: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.featureTile, disabled && styles.disabled, pressed && !disabled && styles.pressed]}
    >
      <View style={styles.featureIcon}>
        <AppIcon android={android} color="#1677FF" fallback="I" ios={ios} size={25} />
      </View>
      <Text style={styles.featureTitle}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actionGrid: {
    gap: 10,
  },
  appBar: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.94)",
    borderColor: "rgba(226,232,240,0.86)",
    borderRadius: 24,
    borderWidth: 1,
    elevation: 8,
    flexDirection: "row",
    height: 58,
    justifyContent: "space-between",
    paddingHorizontal: 12,
    shadowColor: "#0F172A",
    shadowOffset: { height: 10, width: 0 },
    shadowOpacity: 0.1,
    shadowRadius: 22,
  },
  appBarGhost: {
    height: 38,
    width: 38,
  },
  appBarIcon: {
    alignItems: "center",
    backgroundColor: "#EAF2FF",
    borderRadius: 19,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  appBarTitle: {
    color: "#0F172A",
    fontSize: 18,
    fontWeight: "900",
    letterSpacing: 1.2,
  },
  backendPanel: {
    marginTop: -4,
  },
  container: {
    gap: 16,
    padding: 18,
    paddingBottom: 154,
    paddingTop: 24,
  },
  disabled: {
    opacity: 0.55,
  },
  eyebrow: {
    color: "#93C5FD",
    fontSize: 13,
    fontWeight: "900",
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  featureGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  featureIcon: {
    alignItems: "center",
    backgroundColor: "#EAF2FF",
    borderRadius: 18,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  featureTile: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 24,
    borderWidth: 1,
    elevation: 3,
    gap: 12,
    minHeight: 118,
    padding: 16,
    shadowColor: "#0F172A",
    shadowOffset: { height: 8, width: 0 },
    shadowOpacity: 0.07,
    shadowRadius: 16,
    width: "48%",
  },
  featureTitle: {
    color: "#0F172A",
    fontSize: 15,
    fontWeight: "900",
    lineHeight: 20,
  },
  hero: {
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
  panel: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 28,
    borderWidth: 1,
    gap: 14,
    padding: 18,
  },
  pressed: {
    transform: [{ scale: 0.98 }],
  },
  screen: {
    backgroundColor: "#F7FAFF",
    flex: 1,
  },
  settingHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  settingHeaderCopy: {
    flex: 1,
    gap: 3,
  },
  settingIcon: {
    alignItems: "center",
    backgroundColor: "#EAF2FF",
    borderRadius: 20,
    height: 46,
    justifyContent: "center",
    width: 46,
  },
  settingSubtitle: {
    color: "#64748B",
    fontSize: 13,
    lineHeight: 19,
  },
  settingTitle: {
    color: "#0F172A",
    fontSize: 17,
    fontWeight: "900",
  },
  statusRibbon: {
    alignItems: "center",
    backgroundColor: "#ECFDF5",
    borderColor: "#BBF7D0",
    borderRadius: 24,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 16,
  },
  statusRibbonCopy: {
    flex: 1,
    gap: 2,
  },
  statusRibbonText: {
    color: "#166534",
    fontSize: 13,
    lineHeight: 19,
  },
  statusRibbonTitle: {
    color: "#14532D",
    fontSize: 14,
    fontWeight: "900",
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
