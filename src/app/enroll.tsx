import { useRef, useState } from "react";
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { CameraView, type CameraCapturedPicture, type CameraType, useCameraPermissions } from "expo-camera";
import { useLocalSearchParams } from "expo-router";

import { ActionButton } from "@/components/ActionButton";
import { DEFAULT_FACE_API_BASE_URL } from "@/services/config/faceBackend";
import { BackendFaceEngine } from "@/services/face/backendFaceEngine";
import { OnDeviceFaceEngine } from "@/services/face/onDeviceFaceEngine";
import { prepareFaceImageAsync, type PreparedFaceImage } from "@/services/image/prepareFaceImage";
import { saveLocalFaceMetadata } from "@/services/storage/database";

export default function EnrollScreen() {
  const params = useLocalSearchParams<{ apiBaseUrl?: string }>();
  const apiBaseUrl = params.apiBaseUrl ?? DEFAULT_FACE_API_BASE_URL;
  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>("front");
  const [name, setName] = useState("");
  const [personId, setPersonId] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState("Enter a name, capture a clear face, and enroll.");
  const [preparedImage, setPreparedImage] = useState<PreparedFaceImage | null>(null);

  async function captureAndEnroll() {
    if (!cameraRef.current || isProcessing) {
      return;
    }

    if (!name.trim()) {
      setStatus("Name is required for enrollment.");
      return;
    }

    setIsProcessing(true);
    setStatus("Capturing enrollment frame...");

    try {
      const photo = (await cameraRef.current.takePictureAsync({
        quality: 0.72,
        skipProcessing: false,
      })) as CameraCapturedPicture | undefined;

      if (!photo) {
        throw new Error("Camera did not return a picture");
      }

      const prepared = await prepareFaceImageAsync(photo);
      setPreparedImage(prepared);

      setStatus("Running local enrollment engine...");
      const enrollmentPayload = {
        name: name.trim(),
        personId: personId.trim() || undefined,
        imageBase64: prepared.base64,
      };
      let response;
      let enrolledLocally = false;

      try {
        response = await new OnDeviceFaceEngine().enroll(enrollmentPayload);

        if (!response.success) {
          throw new Error(response.error || "Local enrollment failed");
        }

        enrolledLocally = true;
      } catch (localError) {
        setStatus("Local engine unavailable in this build. Trying backend enrollment fallback...");
        response = await new BackendFaceEngine({ apiBaseUrl }).enroll(enrollmentPayload);

        if (!response.success) {
          throw new Error(response.error || "Backend enrollment failed");
        }

        await saveLocalFaceMetadata(response.person_id ?? (personId.trim() || name.trim()), name.trim());
        setStatus(
          localError instanceof Error
            ? `Backend enrollment succeeded. Local embedding unavailable: ${localError.message}`
            : "Backend enrollment succeeded. Local embedding unavailable in this build.",
        );
        return;
      }

      const enrolledPersonId = response.person_id ?? (personId.trim() || name.trim());
      setStatus(`Enrolled ${name.trim()} locally as ${enrolledPersonId}. Trying backend mirror...`);

      try {
        await new BackendFaceEngine({ apiBaseUrl }).enroll(enrollmentPayload);
        setStatus(`Enrolled ${name.trim()} locally and mirrored to backend.`);
      } catch {
        setStatus(
          enrolledLocally
            ? `Enrolled ${name.trim()} locally. Backend mirror skipped/offline; sync can happen later.`
            : `Enrolled ${name.trim()} as ${enrolledPersonId}.`,
        );
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Enrollment failed");
    } finally {
      setIsProcessing(false);
    }
  }

  if (!permission) {
    return <View style={styles.center} />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.permissionTitle}>Camera permission needed</Text>
        <Text style={styles.permissionText}>Enrollment needs camera access to capture a face image.</Text>
        <ActionButton onPress={requestPermission} title="Allow Camera" />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.formCard}>
        <Text style={styles.label}>Name</Text>
        <TextInput onChangeText={setName} placeholder="Person name" style={styles.input} value={name} />
        <Text style={styles.label}>Person ID optional</Text>
        <TextInput
          autoCapitalize="none"
          onChangeText={setPersonId}
          placeholder="Defaults to name"
          style={styles.input}
          value={personId}
        />
      </View>

      <View style={styles.cameraCard}>
        <CameraView ref={cameraRef} facing={facing} style={styles.camera} />
      </View>

      <View style={styles.controls}>
        <ActionButton disabled={isProcessing} onPress={captureAndEnroll} title="Capture & Enroll" />
        <ActionButton
          disabled={isProcessing}
          onPress={() => setFacing((current) => (current === "front" ? "back" : "front"))}
          title="Switch Camera"
          variant="secondary"
        />
      </View>

      <View style={styles.statusBox}>
        {isProcessing ? <ActivityIndicator color="#1677FF" /> : null}
        <Text style={styles.statusText}>{status}</Text>
      </View>

      {preparedImage ? (
        <View style={styles.previewCard}>
          <Text style={styles.sectionTitle}>Last Enrollment Frame</Text>
          <Image source={{ uri: preparedImage.uri }} style={styles.preview} />
        </View>
      ) : null}
    </ScrollView>
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
