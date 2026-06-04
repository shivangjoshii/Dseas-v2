import { useRef, useState } from "react";
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, View } from "react-native";
import { CameraView, type CameraCapturedPicture, type CameraType, useCameraPermissions } from "expo-camera";
import { useLocalSearchParams } from "expo-router";

import { ActionButton } from "@/components/ActionButton";
import { withTimeout } from "@/services/async/withTimeout";
import { pickRealtimePictureSize } from "@/services/camera/pictureSize";
import { DEFAULT_FACE_API_BASE_URL } from "@/services/config/faceBackend";
import { BackendFaceEngine } from "@/services/face/backendFaceEngine";
import { OnDeviceFaceEngine } from "@/services/face/onDeviceFaceEngine";
import type { FaceDetectionResult, FaceRecognitionResult } from "@/services/face/types";
import { prepareFaceImageAsync, type PreparedFaceImage } from "@/services/image/prepareFaceImage";
import { saveAttendanceRecord } from "@/services/storage/database";

const RECOGNITION_CAPTURE_SIZE = 256;
const ACTIVE_HEAD_TURN_THRESHOLD = 0.075;
const ACTIVE_LIVENESS_FRAMES = 3;
const ACTIVE_LIVENESS_DELAY_MS = 140;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateHeadYaw(result: FaceDetectionResult) {
  if (result.landmarks.length < 3) {
    return 0;
  }

  const [leftEye, rightEye, nose] = result.landmarks;
  const [top, right, bottom, left] = result.bbox;
  const faceWidth = Math.max(1, right - left);
  const eyeCenterX = (leftEye[0] + rightEye[0]) / 2;
  const verticalPenalty = Math.max(1, bottom - top) / faceWidth;

  return ((nose[0] - eyeCenterX) / faceWidth) * verticalPenalty;
}

export default function RecognizeScreen() {
  const params = useLocalSearchParams<{ apiBaseUrl?: string }>();
  const apiBaseUrl = params.apiBaseUrl ?? DEFAULT_FACE_API_BASE_URL;
  const cameraRef = useRef<CameraView | null>(null);
  const localEngineRef = useRef(new OnDeviceFaceEngine());
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>("front");
  const [cameraReady, setCameraReady] = useState(false);
  const [pictureSize, setPictureSize] = useState<string | undefined>();
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState("Capture a face to recognize and mark attendance.");
  const [livenessStatus, setLivenessStatus] = useState("Active liveness required before marking.");
  const [preparedImage, setPreparedImage] = useState<PreparedFaceImage | null>(null);
  const [results, setResults] = useState<FaceRecognitionResult[]>([]);

  async function capturePreparedFrame() {
    if (!cameraRef.current) {
      throw new Error("Camera is not ready");
    }

    const photo = (await cameraRef.current.takePictureAsync({
      quality: 0.24,
      shutterSound: false,
      skipProcessing: true,
    })) as CameraCapturedPicture | undefined;

    if (!photo) {
      throw new Error("Camera did not return a picture");
    }

    return prepareFaceImageAsync(photo, {
      compress: 0.24,
      size: RECOGNITION_CAPTURE_SIZE,
    });
  }

  async function runActiveLivenessChallenge() {
    let minYaw: number | null = null;
    let maxYaw: number | null = null;
    let validFrames = 0;
    let latestPrepared: PreparedFaceImage | null = null;
    let latestDetection: FaceDetectionResult | null = null;

    setLivenessStatus("Look at camera, then turn head left/right.");

    for (let frameIndex = 0; frameIndex < ACTIVE_LIVENESS_FRAMES; frameIndex += 1) {
      if (frameIndex > 0) {
        await wait(ACTIVE_LIVENESS_DELAY_MS);
      }

      const prepared = await capturePreparedFrame();
      const detection = await withTimeout(
        localEngineRef.current.detect({
          confidenceThreshold: 0.55,
          imageBase64: prepared.base64,
          livenessMode: "passive",
          maxDetections: 1,
        }),
        1200,
        "Active liveness detection timed out",
      );
      const face = detection.detections[0];

      if (!face) {
        setLivenessStatus("No face found. Keep your face inside frame.");
        continue;
      }

      const yaw = estimateHeadYaw(face);
      validFrames += 1;
      minYaw = minYaw === null ? yaw : Math.min(minYaw, yaw);
      maxYaw = maxYaw === null ? yaw : Math.max(maxYaw, yaw);
      latestPrepared = prepared;
      latestDetection = face;

      if (validFrames >= ACTIVE_LIVENESS_FRAMES && maxYaw - minYaw >= ACTIVE_HEAD_TURN_THRESHOLD) {
        setLivenessStatus("Active liveness verified.");
        return {
          detection: latestDetection,
          prepared: latestPrepared,
        };
      }

      setLivenessStatus(yaw < 0 ? "Turn head right a little." : "Turn head left a little.");
    }

    throw new Error("Active liveness failed. Static photos/screenshots are blocked. Turn your real face left and right.");
  }

  async function configureFastPictureSize() {
    try {
      const availableSizes = await cameraRef.current?.getAvailablePictureSizesAsync();
      const fastSize = pickRealtimePictureSize(availableSizes ?? []);

      if (fastSize) {
        setPictureSize(fastSize);
      }
    } catch {
      setPictureSize(undefined);
    }
  }

  async function captureAndRecognize() {
    if (!cameraRef.current || isProcessing || !cameraReady) {
      return;
    }

    setIsProcessing(true);
    setStatus("Verifying active liveness...");

    try {
      const { detection, prepared } = await runActiveLivenessChallenge();
      setPreparedImage(prepared);

      setStatus("Running on-device recognition on verified live face...");
      let response;
      let usedBackendFallback = false;

      try {
        response = await withTimeout(
          localEngineRef.current.recognizeDetectedPrimary({
            detection,
            imageBase64: prepared.base64,
            maxFaces: 1,
          }),
          1200,
          "On-device recognition timed out",
        );
      } catch (localError) {
        usedBackendFallback = true;
        setStatus("On-device engine could not run. Trying backend fallback...");
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
          liveness_verified: true,
          location: usedBackendFallback ? "MOBILE_BACKEND_FALLBACK_RECOGNITION" : "MOBILE_ON_DEVICE_RECOGNITION",
          synced: false,
          cloud_id: null,
          source: usedBackendFallback ? "backend" : "local",
        });
      }

      setStatus(
        matches.length > 0
          ? `Marked ${matches.length} attendance record${matches.length === 1 ? "" : "s"} in local sync queue.`
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
        <CameraView
          animateShutter={false}
          ref={cameraRef}
          facing={facing}
          onCameraReady={() => {
            setCameraReady(true);
            void configureFastPictureSize();
          }}
          pictureSize={pictureSize}
          style={styles.camera}
        />
      </View>

      <View style={styles.controls}>
        <ActionButton disabled={isProcessing || !cameraReady} onPress={captureAndRecognize} title="Verify Live & Recognize" />
        <ActionButton
          disabled={isProcessing}
          onPress={() => {
            setCameraReady(false);
            setPictureSize(undefined);
            setFacing((current) => (current === "front" ? "back" : "front"));
          }}
          title="Switch Camera"
          variant="secondary"
        />
      </View>

      <View style={styles.statusBox}>
        {isProcessing ? <ActivityIndicator color="#1677FF" /> : null}
        <Text style={styles.statusText}>{status}</Text>
      </View>
      <View style={styles.livenessBox}>
        <Text style={styles.livenessText}>{livenessStatus}</Text>
      </View>

      {preparedImage ? (
        <View style={styles.previewCard}>
          <Text style={styles.sectionTitle}>Prepared Local Frame</Text>
          <Image source={{ uri: preparedImage.uri }} style={styles.preview} />
          <Text style={styles.muted}>
            Processed as a {RECOGNITION_CAPTURE_SIZE}x{RECOGNITION_CAPTURE_SIZE} fast JPEG frame for the local
            engine first.
          </Text>
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
  livenessBox: {
    backgroundColor: "#ECFDF5",
    borderColor: "#BBF7D0",
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
  },
  livenessText: {
    color: "#166534",
    fontSize: 14,
    fontWeight: "900",
    lineHeight: 20,
    textAlign: "center",
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
