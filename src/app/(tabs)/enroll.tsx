import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Image, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from "react-native";
import { CameraView, type CameraCapturedPicture, type CameraType, useCameraPermissions } from "expo-camera";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { ActionButton } from "@/components/ActionButton";
import { FloatingSnackbar, type SnackbarState } from "@/components/FloatingSnackbar";
import { withTimeout } from "@/services/async/withTimeout";
import { DEFAULT_FACE_API_BASE_URL } from "@/services/config/faceBackend";
import { BackendFaceEngine } from "@/services/face/engines/backendFaceEngine";
import { OnDeviceFaceEngine } from "@/services/face/engines/onDeviceFaceEngine";
import { prepareFaceImageAsync, type PreparedFaceImage } from "@/services/image/prepareFaceImage";
import { generateUniqueId } from "@/services/face/utils/idUtils";
import { saveLocalFaceMetadata } from "@/services/storage/database";

const INITIAL_ENROLL_STATUS = "Capture a clear face to begin enrollment.";

export default function EnrollScreen() {
  const params = useLocalSearchParams<{ apiBaseUrl?: string }>();
  const apiBaseUrl = params.apiBaseUrl ?? DEFAULT_FACE_API_BASE_URL;
  const cameraRef = useRef<CameraView | null>(null);
  const completedEnrollmentRef = useRef(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>("front");
  const [name, setName] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState(INITIAL_ENROLL_STATUS);
  const [preparedImage, setPreparedImage] = useState<PreparedFaceImage | null>(null);
  const [snackbar, setSnackbar] = useState<SnackbarState>({ message: "", visible: false });

  function showSnackbar(message: string, tone: SnackbarState["tone"] = "info") {
    setSnackbar({ message, tone, visible: true });
  }

  const resetCompletedEnrollment = useCallback(() => {
    setName("");
    setPreparedImage(null);
    setStatus(INITIAL_ENROLL_STATUS);
    setSnackbar({ message: "", visible: false });
    completedEnrollmentRef.current = false;
  }, []);

  useFocusEffect(
    useCallback(() => {
      return () => {
        if (completedEnrollmentRef.current) {
          resetCompletedEnrollment();
        }
      };
    }, [resetCompletedEnrollment]),
  );

  async function handleCapture() {
    if (!cameraRef.current || isProcessing) return;

    setIsProcessing(true);
    setStatus("Capturing face...");
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.72,
        skipProcessing: false,
      });

      if (!photo) throw new Error("Capture failed");

      const prepared = await prepareFaceImageAsync(photo);
      setPreparedImage(prepared);
      setStatus("Face captured. Enter name and enroll.");
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Capture failed";
      setStatus(msg);
      showSnackbar(msg, "error");
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleEnroll() {
    if (!preparedImage || isProcessing) return;

    if (!name.trim()) {
      showSnackbar("Please enter a name", "error");
      return;
    }

    setIsProcessing(true);
    setStatus("Processing enrollment...");

    try {
      const personId = generateUniqueId("user");
      const payload = {
        name: name.trim(),
        personId,
        imageBase64: preparedImage.base64,
      };

      try {
        const res = await withTimeout(
          new OnDeviceFaceEngine().enroll(payload),
          15000,
          "Enrollment timed out"
        );

        if (!res.success) throw new Error(res.error || "Local enrollment failed");

        completedEnrollmentRef.current = true;
        setStatus(`Success! Enrolled ${name.trim()} (ID: ${personId})`);
        showSnackbar(`Enrolled: ${name.trim()}`, "success");
        return;
      } catch (localError) {
        // Fallback to backend if local fails
        const backendRes = await new BackendFaceEngine({ apiBaseUrl }).enroll(payload);
        if (!backendRes.success) throw new Error(backendRes.error || "Backend enrollment failed");

        await saveLocalFaceMetadata(personId, name.trim(), null, { synced: true });
        completedEnrollmentRef.current = true;
        setStatus(`Enrolled ${name.trim()} via backend fallback`);
        showSnackbar("Enrolled using backend", "success");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Enrollment failed";
      setStatus(msg);
      showSnackbar(msg, "error");
    } finally {
      setIsProcessing(false);
    }
  }

  if (!permission) return <View style={styles.center} />;
  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.permissionTitle}>Camera access required</Text>
        <ActionButton onPress={requestPermission} title="Allow Camera" />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar backgroundColor="#0F172A" barStyle="light-content" />
      <SafeAreaView edges={["top"]} style={styles.standardAppBarSafeArea}>
        <View style={styles.standardAppBar}>
          <Text style={styles.standardAppBarTitle}>Face Enrollment</Text>
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        {!preparedImage ? (
          <>
            <View style={styles.cameraCard}>
              <CameraView ref={cameraRef} facing={facing} style={styles.camera} />
            </View>
            <View style={styles.controls}>
              <ActionButton disabled={isProcessing} onPress={handleCapture} title="Capture Face" />
              <ActionButton
                disabled={isProcessing}
                onPress={() => setFacing((c) => (c === "front" ? "back" : "front"))}
                title="Switch Camera"
                variant="secondary"
              />
            </View>
          </>
        ) : (
          <>
            <View style={styles.previewCard}>
              <Text style={styles.sectionTitle}>Review Capture</Text>
              <Image source={{ uri: preparedImage.uri }} style={styles.preview} />
            </View>
            <View style={styles.formCard}>
              <Text style={styles.label}>Full Name</Text>
              <TextInput
                autoFocus
                onChangeText={setName}
                placeholder="Enter person's name"
                style={styles.input}
                value={name}
              />
              <ActionButton disabled={isProcessing} onPress={handleEnroll} title="Confirm & Enroll" />
              <ActionButton
                disabled={isProcessing}
                onPress={() => setPreparedImage(null)}
                title="Retake Photo"
                variant="secondary"
              />
            </View>
          </>
        )}

        <View style={styles.statusBox}>
          {isProcessing ? <ActivityIndicator color="#1677FF" style={{ marginRight: 8 }} /> : null}
          <Text style={styles.statusText}>{status}</Text>
        </View>
      </ScrollView>

      <FloatingSnackbar
        message={snackbar.message}
        onDismiss={() => setSnackbar((current) => ({ ...current, visible: false }))}
        tone={snackbar.tone}
        visible={snackbar.visible}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  camera: {
    aspectRatio: 3 / 4,
    borderRadius: 24,
    overflow: "hidden",
    width: "100%",
  },
  cameraCard: {
    backgroundColor: "#0F172A",
    borderRadius: 28,
    overflow: "hidden",
    padding: 4,
  },
  center: {
    alignItems: "center",
    backgroundColor: "#F7FAFF",
    flex: 1,
    gap: 14,
    justifyContent: "center",
    padding: 24,
  },
  container: {
    backgroundColor: "#F7FAFF",
    gap: 16,
    padding: 18,
    paddingBottom: 154,
  },
  controls: {
    gap: 10,
  },
  formCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 22,
    gap: 10,
    padding: 16,
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
  permissionText: {
    color: "#64748B",
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
  },
  permissionTitle: {
    color: "#0F172A",
    fontSize: 24,
    fontWeight: "900",
  },
  preview: {
    aspectRatio: 1,
    backgroundColor: "#E2E8F0",
    borderRadius: 18,
    width: "100%",
  },
  previewCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 22,
    gap: 10,
    padding: 16,
  },
  screen: {
    backgroundColor: "#F7FAFF",
    flex: 1,
  },
  standardAppBar: {
    alignItems: "center",
    backgroundColor: "#0F172A",
    height: 56,
    justifyContent: "center",
  },
  standardAppBarSafeArea: {
    backgroundColor: "#0F172A",
  },
  standardAppBarTitle: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "900",
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
});
