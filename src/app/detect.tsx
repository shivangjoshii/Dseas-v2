import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, View, type DimensionValue } from "react-native";
import { CameraView, type CameraCapturedPicture, type CameraType, useCameraPermissions } from "expo-camera";
import { useLocalSearchParams } from "expo-router";

import { ActionButton } from "@/components/ActionButton";
import { withTimeout } from "@/services/async/withTimeout";
import { DEFAULT_FACE_API_BASE_URL } from "@/services/config/faceBackend";
import { BackendFaceEngine } from "@/services/face/backendFaceEngine";
import { OnDeviceFaceEngine } from "@/services/face/onDeviceFaceEngine";
import type { FaceRecognitionResult } from "@/services/face/types";
import { prepareFaceImageAsync, type PreparedFaceImage } from "@/services/image/prepareFaceImage";

const FRAME_SIZE = 320;
const LIVE_FRAME_DELAY_MS = 900;

function toPercent(value: number): DimensionValue {
  return `${Math.max(0, Math.min(100, (value / FRAME_SIZE) * 100))}%` as DimensionValue;
}

function RecognitionOverlay({ results }: { results: FaceRecognitionResult[] }) {
  return (
    <View pointerEvents="none" style={styles.overlay}>
      {results.map((result, resultIndex) => {
        const [top, right, bottom, left] = result.bbox;
        const isKnown = result.person_id !== "unknown";
        const color = isKnown ? "#22C55E" : "#F59E0B";
        const label = `${result.name || "Unknown"} (${(result.score * 100).toFixed(1)}%)`;

        return (
          <View
            key={`box-${result.person_id}-${resultIndex}`}
            style={[
              styles.faceBox,
              {
                borderColor: color,
                height: toPercent(bottom - top),
                left: toPercent(left),
                top: toPercent(top),
                width: toPercent(right - left),
              },
            ]}
          >
            <Text style={[styles.faceBoxLabel, { backgroundColor: color }]}>{label}</Text>
          </View>
        );
      })}

      {results.flatMap((result, resultIndex) => {
        const isKnown = result.person_id !== "unknown";

        return result.landmarks.map(([x, y], landmarkIndex) => (
          <View
            key={`landmark-${resultIndex}-${landmarkIndex}`}
            style={[
              styles.landmark,
              {
                backgroundColor: isKnown ? "#EF4444" : "#FFFFFF",
                left: toPercent(x),
                top: toPercent(y),
              },
            ]}
          />
        ));
      })}
    </View>
  );
}

export default function DetectScreen() {
  const params = useLocalSearchParams<{ apiBaseUrl?: string }>();
  const apiBaseUrl = params.apiBaseUrl ?? DEFAULT_FACE_API_BASE_URL;
  const cameraRef = useRef<CameraView | null>(null);
  const localEngineUnavailableReasonRef = useRef<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>("front");
  const [cameraReady, setCameraReady] = useState(false);
  const [isLive, setIsLive] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState("Starting live face detection...");
  const [preparedImage, setPreparedImage] = useState<PreparedFaceImage | null>(null);
  const [results, setResults] = useState<FaceRecognitionResult[]>([]);

  useEffect(() => {
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    async function recognizeWithFallback(imageBase64: string) {
      if (!localEngineUnavailableReasonRef.current) {
        try {
          const response = await withTimeout(
            new OnDeviceFaceEngine().recognize({ imageBase64 }),
            8000,
            "On-device recognition timed out",
          );

          return {
            engine: "on-device" as const,
            results: response.results,
            fallbackReason: null,
          };
        } catch (localError) {
          localEngineUnavailableReasonRef.current =
            localError instanceof Error ? localError.message : "Local engine unavailable";
        }
      }

      const response = await new BackendFaceEngine({ apiBaseUrl }).recognize({ imageBase64 });
      const fallbackReason = `Local engine fallback: ${localEngineUnavailableReasonRef.current}`;

      return {
        engine: "backend" as const,
        results: response.results.map((result) => ({
          ...result,
          engine: "backend" as const,
          liveness_verified: true,
          liveness_score: 1,
          liveness_reason: fallbackReason,
        })),
        fallbackReason,
      };
    }

    async function processFrame() {
      if (cancelled || !isLive || !permission?.granted || !cameraReady || !cameraRef.current) {
        return;
      }

      setIsProcessing(true);

      try {
        const startTime = Date.now();
        const photo = (await cameraRef.current.takePictureAsync({
          quality: 0.55,
          skipProcessing: false,
        })) as CameraCapturedPicture | undefined;

        if (!photo) {
          throw new Error("Camera did not return a picture");
        }

        const prepared = await prepareFaceImageAsync(photo);
        const recognition = await recognizeWithFallback(prepared.base64);

        if (!cancelled) {
          setPreparedImage(prepared);
          setResults(recognition.results);
          setStatus(
            `${recognition.engine === "on-device" ? "On-device" : "Backend"} live: ${
              Date.now() - startTime
            }ms | Faces: ${recognition.results.length}${
              recognition.fallbackReason ? ` | ${recognition.fallbackReason}` : ""
            }`,
          );
        }
      } catch (error) {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : "Live face detection failed");
        }
      } finally {
        if (!cancelled) {
          setIsProcessing(false);
          timeout = setTimeout(processFrame, LIVE_FRAME_DELAY_MS);
        }
      }
    }

    if (isLive && permission?.granted && cameraReady) {
      timeout = setTimeout(processFrame, 150);
    }

    return () => {
      cancelled = true;

      if (timeout) {
        clearTimeout(timeout);
      }
    };
  }, [apiBaseUrl, cameraReady, isLive, permission?.granted]);

  function switchCamera() {
    setCameraReady(false);
    setPreparedImage(null);
    setResults([]);
    setStatus("Switching camera...");
    setFacing((current) => (current === "front" ? "back" : "front"));
  }

  if (!permission) {
    return <View style={styles.center} />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.permissionTitle}>Camera permission needed</Text>
        <Text style={styles.permissionText}>Realtime face detection needs camera access.</Text>
        <ActionButton onPress={requestPermission} title="Allow Camera" />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.cameraFrame}>
        <CameraView
          key={facing}
          ref={cameraRef}
          facing={facing}
          onCameraReady={() => {
            setCameraReady(true);
            setStatus(isLive ? "Camera ready. Live detection running..." : "Camera ready.");
          }}
          style={styles.camera}
        />
        <RecognitionOverlay results={results} />
      </View>

      <View style={styles.controls}>
        <ActionButton
          disabled={!cameraReady}
          onPress={() => setIsLive((current) => !current)}
          title={isLive ? "Stop Live Detection" : "Start Live Detection"}
        />
        <ActionButton disabled={isProcessing} onPress={switchCamera} title="Switch Camera" variant="secondary" />
      </View>

      <View style={styles.statusBox}>
        {isProcessing ? <ActivityIndicator color="#1677FF" /> : null}
        <Text style={styles.statusText}>{status}</Text>
      </View>

      {preparedImage ? (
        <View style={styles.previewCard}>
          <Text style={styles.sectionTitle}>Last 320x320 Processed Frame</Text>
          <View style={styles.previewFrame}>
            <Image source={{ uri: preparedImage.uri }} style={styles.previewImage} />
            <RecognitionOverlay results={results} />
          </View>
          <Text style={styles.muted}>
            Green boxes are known faces. Amber boxes are unknown faces. Points are SCRFD landmarks.
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  camera: {
    height: "100%",
    width: "100%",
  },
  cameraFrame: {
    aspectRatio: 1,
    backgroundColor: "#0F172A",
    borderRadius: 28,
    overflow: "hidden",
    position: "relative",
    width: "100%",
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
  faceBox: {
    borderRadius: 10,
    borderWidth: 3,
    position: "absolute",
  },
  faceBoxLabel: {
    borderBottomRightRadius: 8,
    color: "#020617",
    fontSize: 11,
    fontWeight: "900",
    left: 0,
    maxWidth: 160,
    paddingHorizontal: 6,
    paddingVertical: 3,
    position: "absolute",
    top: 0,
  },
  landmark: {
    borderColor: "#020617",
    borderRadius: 4,
    borderWidth: 1,
    height: 8,
    marginLeft: -4,
    marginTop: -4,
    position: "absolute",
    width: 8,
  },
  muted: {
    color: "#64748B",
    fontSize: 13,
    lineHeight: 19,
  },
  overlay: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
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
  previewCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 22,
    gap: 10,
    padding: 16,
  },
  previewFrame: {
    aspectRatio: 1,
    backgroundColor: "#E2E8F0",
    borderRadius: 18,
    overflow: "hidden",
    position: "relative",
    width: "100%",
  },
  previewImage: {
    height: "100%",
    position: "absolute",
    width: "100%",
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
