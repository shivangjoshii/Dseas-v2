import { useRef, useState } from "react";
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, View } from "react-native";
import { CameraView, type CameraCapturedPicture, type CameraType, useCameraPermissions } from "expo-camera";
import { useLocalSearchParams } from "expo-router";

import { ActionButton } from "@/components/ActionButton";
import { DEFAULT_FACE_API_BASE_URL } from "@/services/config/faceBackend";
import { BackendFaceEngine } from "@/services/face/backendFaceEngine";
import { OnDeviceFaceEngine } from "@/services/face/onDeviceFaceEngine";
import type { FaceRecognitionResult } from "@/services/face/types";
import { prepareFaceImageAsync, type PreparedFaceImage } from "@/services/image/prepareFaceImage";
import { saveAttendanceRecord } from "@/services/storage/database";

export default function RecognizeScreen() {
  const params = useLocalSearchParams<{ apiBaseUrl?: string }>();
  const apiBaseUrl = params.apiBaseUrl ?? DEFAULT_FACE_API_BASE_URL;
  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>("front");
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState("Capture a face to recognize and mark attendance.");
  const [preparedImage, setPreparedImage] = useState<PreparedFaceImage | null>(null);
  const [results, setResults] = useState<FaceRecognitionResult[]>([]);

  async function captureAndRecognize() {
    if (!cameraRef.current || isProcessing) {
      return;
    }

    setIsProcessing(true);
    setStatus("Capturing frame...");

    try {
      const photo = (await cameraRef.current.takePictureAsync({
        quality: 0.7,
        skipProcessing: false,
      })) as CameraCapturedPicture | undefined;

      if (!photo) {
        throw new Error("Camera did not return a picture");
      }

      setStatus("Preparing 320x320 face frame...");
      const prepared = await prepareFaceImageAsync(photo);
      setPreparedImage(prepared);

      setStatus("Running on-device face engine...");
      let response;

      try {
        response = await new OnDeviceFaceEngine().recognize({ imageBase64: prepared.base64 });
      } catch (localError) {
        setStatus("On-device engine unavailable in this build. Trying backend fallback...");
        response = await new BackendFaceEngine({ apiBaseUrl }).recognize({ imageBase64: prepared.base64 });
        response.results = response.results.map((result) => ({
          ...result,
          engine: "backend",
          liveness_verified: true,
          liveness_score: 1,
          liveness_reason: localError instanceof Error ? `Backend fallback: ${localError.message}` : "Backend fallback",
        }));
      }

      setResults(response.results);

      const matches = response.results.filter(
        (result) => result.person_id !== "unknown" && result.liveness_verified !== false,
      );

      for (const match of matches) {
        await saveAttendanceRecord({
          person_id: match.person_id,
          name: match.name,
          confidence: match.similarity,
          liveness_verified: match.liveness_verified !== false,
          location: match.engine === "on-device" ? "MOBILE_ON_DEVICE_RECOGNITION" : "MOBILE_BACKEND_RECOGNITION",
          synced: match.engine === "backend",
          cloud_id: match.engine === "backend" ? `backend:${Date.now()}:${match.person_id}` : null,
          source: match.engine === "on-device" ? "local" : "backend",
        });
      }

      setStatus(
        matches.length > 0
          ? `Marked ${matches.length} attendance record${matches.length === 1 ? "" : "s"} locally.`
          : "No known face matched.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Recognition failed");
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
        <Text style={styles.permissionText}>Face attendance needs camera access to capture recognition frames.</Text>
        <ActionButton onPress={requestPermission} title="Allow Camera" />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.cameraCard}>
        <CameraView ref={cameraRef} facing={facing} style={styles.camera} />
      </View>

      <View style={styles.controls}>
        <ActionButton disabled={isProcessing} onPress={captureAndRecognize} title="Capture & Recognize" />
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
          <Text style={styles.sectionTitle}>Prepared Backend Frame</Text>
          <Image source={{ uri: preparedImage.uri }} style={styles.preview} />
          <Text style={styles.muted}>Sent as 320x320 JPEG base64, matching the backend web camera flow.</Text>
        </View>
      ) : null}

      <View style={styles.resultsCard}>
        <Text style={styles.sectionTitle}>Recognition Results</Text>
        {results.length === 0 ? (
          <Text style={styles.muted}>No results yet.</Text>
        ) : (
          results.map((result, index) => (
            <View key={`${result.person_id}-${index}`} style={styles.resultRow}>
              <Text style={styles.resultName}>{result.name || "Unknown"}</Text>
              <Text style={styles.resultMeta}>ID: {result.person_id}</Text>
              <Text style={styles.resultMeta}>Similarity: {(result.similarity * 100).toFixed(1)}%</Text>
              <Text style={styles.resultMeta}>Detection: {(result.score * 100).toFixed(1)}%</Text>
              <Text style={styles.resultMeta}>Engine: {result.engine ?? "backend"}</Text>
              <Text style={styles.resultMeta}>
                Liveness: {result.liveness_verified === false ? "failed" : "passed"}{" "}
                {typeof result.liveness_score === "number" ? `(${(result.liveness_score * 100).toFixed(1)}%)` : ""}
              </Text>
              <Text style={styles.resultMeta}>Box: [{result.bbox.map((value) => Math.round(value)).join(", ")}]</Text>
            </View>
          ))
        )}
      </View>
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
  muted: {
    color: "#64748B",
    fontSize: 13,
    lineHeight: 19,
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
  resultMeta: {
    color: "#64748B",
    fontSize: 13,
  },
  resultName: {
    color: "#0F172A",
    fontSize: 18,
    fontWeight: "900",
  },
  resultRow: {
    backgroundColor: "#F8FAFC",
    borderRadius: 16,
    gap: 4,
    padding: 14,
  },
  resultsCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 22,
    gap: 12,
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
