import { useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";
import { CameraView, type CameraCapturedPicture, type CameraType, useCameraPermissions } from "expo-camera";
import { useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, { FadeInDown, Layout } from "react-native-reanimated";

import { ActionButton } from "@/components/ActionButton";
import { withTimeout } from "@/services/async/withTimeout";
import { pickRealtimePictureSize } from "@/services/camera/pictureSize";
import { DEFAULT_FACE_API_BASE_URL } from "@/services/config/faceBackend";
import { BackendFaceEngine } from "@/services/face/engines/backendFaceEngine";
import { OnDeviceFaceEngine } from "@/services/face/engines/onDeviceFaceEngine";
import type { FaceDetectionResult } from "@/services/face/types";
import { prepareFaceImageAsync, type PreparedFaceImage } from "@/services/image/prepareFaceImage";
import { saveAttendanceRecord } from "@/services/storage/database";

const RECOGNITION_CAPTURE_SIZE = 224;
const ACTIVE_HEAD_TURN_THRESHOLD = 0.075;
const ACTIVE_LIVENESS_FRAMES = 2;
const ACTIVE_LIVENESS_DELAY_MS = 110;

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
  const [status, setStatus] = useState("Scan your face to mark attendance.");
  const [livenessStatus, setLivenessStatus] = useState("");
  const [lastMatch, setLastMatch] = useState<{ name: string; time: string } | null>(null);

  async function capturePreparedFrame() {
    if (!cameraRef.current) throw new Error("Camera is not ready");

    const photo = (await cameraRef.current.takePictureAsync({
      quality: 0.18,
      shutterSound: false,
      skipProcessing: true,
    })) as CameraCapturedPicture | undefined;

    if (!photo) throw new Error("Capture failed");

    return prepareFaceImageAsync(photo, {
      compress: 0.18,
      size: RECOGNITION_CAPTURE_SIZE,
    });
  }

  async function runActiveLivenessChallenge() {
    let minYaw: number | null = null;
    let maxYaw: number | null = null;
    let validFrames = 0;
    let latestPrepared: PreparedFaceImage | null = null;
    let latestDetection: FaceDetectionResult | null = null;

    setLivenessStatus("Turn your head slowly left/right");

    for (let frameIndex = 0; frameIndex < ACTIVE_LIVENESS_FRAMES * 2; frameIndex++) {
      if (frameIndex > 0) await wait(ACTIVE_LIVENESS_DELAY_MS);

      const prepared = await capturePreparedFrame();
      const detection = await withTimeout(
        localEngineRef.current.detect({
          confidenceThreshold: 0.55,
          imageBase64: prepared.base64,
          livenessMode: "passive",
          maxDetections: 1,
        }),
        1200,
        "Detection timeout",
      );
      const face = detection.detections[0];

      if (!face) {
        setLivenessStatus("No face found. Center your face.");
        continue;
      }

      const yaw = estimateHeadYaw(face);
      validFrames++;
      minYaw = minYaw === null ? yaw : Math.min(minYaw, yaw);
      maxYaw = maxYaw === null ? yaw : Math.max(maxYaw, yaw);
      latestPrepared = prepared;
      latestDetection = face;

      if (validFrames >= ACTIVE_LIVENESS_FRAMES && maxYaw - minYaw >= ACTIVE_HEAD_TURN_THRESHOLD) {
        setLivenessStatus("");
        return { detection: latestDetection, prepared: latestPrepared };
      }

      setLivenessStatus(yaw < 0 ? "Turn head right →" : "← Turn head left");
    }

    throw new Error("Liveness check failed. Please move your head left and right.");
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
    if (!cameraRef.current || isProcessing || !cameraReady) return;

    setIsProcessing(true);
    setLastMatch(null);
    setStatus("Verifying identity...");

    try {
      const { detection, prepared } = await runActiveLivenessChallenge();

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
          "Local recognition timeout",
        );
      } catch (localError) {
        usedBackendFallback = true;
        setStatus("Trying backup engine...");
        response = await new BackendFaceEngine({ apiBaseUrl }).recognize({ imageBase64: prepared.base64 });
      }

      const match = response.results.find(
        (result) => result.person_id !== "unknown" && result.liveness_verified !== false,
      );

      if (match) {
        await saveAttendanceRecord({
          person_id: match.person_id,
          name: match.name,
          confidence: match.similarity,
          liveness_verified: true,
          location: usedBackendFallback ? "BACKEND_FALLBACK" : "LOCAL_ENGINE",
          synced: false,
          source: usedBackendFallback ? "backend" : "local",
        });

        setLastMatch({
          name: match.name,
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        });
        setStatus("Ready for next scan.");
      } else {
        setStatus("Identity not recognized. Ensure you are enrolled.");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Recognition failed");
      setLivenessStatus("");
    } finally {
      setIsProcessing(false);
    }
  }

  if (!permission) return <View style={styles.center} />;
  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.permissionTitle}>Camera Required</Text>
        <ActionButton onPress={requestPermission} title="Allow Camera" />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar backgroundColor="#0F172A" barStyle="light-content" />
      <SafeAreaView edges={["top"]} style={styles.standardAppBarSafeArea}>
        <View style={styles.standardAppBar}>
          <Text style={styles.standardAppBarTitle}>Attendance</Text>
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.container} scrollEnabled={!lastMatch}>
        {lastMatch ? (
          <Animated.View entering={FadeInDown.springify()} layout={Layout.springify()} style={styles.successCard}>
            <View style={styles.successIconOuter}>
              <View style={styles.successIconInner}>
                <Text style={styles.successCheck}>✓</Text>
              </View>
            </View>
            <Text style={styles.successTitle}>Attendance Marked</Text>
            <View style={styles.successDetails}>
              <Text style={styles.successName}>{lastMatch.name}</Text>
              <Text style={styles.successTime}>{lastMatch.time}</Text>
            </View>
            <ActionButton onPress={() => setLastMatch(null)} title="Mark Another" />
          </Animated.View>
        ) : (
          <>
            <Animated.View layout={Layout.springify()} style={styles.cameraCard}>
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
              {livenessStatus ? (
                <View style={styles.livenessOverlay}>
                  <Text style={styles.livenessText}>{livenessStatus}</Text>
                </View>
              ) : null}
            </Animated.View>

            <View style={styles.controls}>
              <ActionButton
                disabled={isProcessing || !cameraReady}
                onPress={captureAndRecognize}
                title={isProcessing ? "Verifying..." : "Mark Attendance"}
              />
              {!isProcessing && (
                <ActionButton
                  onPress={() => setFacing((c) => (c === "front" ? "back" : "front"))}
                  title="Switch Camera"
                  variant="secondary"
                />
              )}
            </View>

            <View style={styles.statusBox}>
              {isProcessing ? <ActivityIndicator color="#1677FF" style={{ marginRight: 10 }} /> : null}
              <Text style={styles.statusText}>{status}</Text>
            </View>
          </>
        )}
      </ScrollView>
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
    position: "relative",
  },
  center: {
    alignItems: "center",
    backgroundColor: "#F7FAFF",
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  container: {
    backgroundColor: "#F7FAFF",
    gap: 20,
    padding: 20,
  },
  controls: {
    gap: 12,
  },
  livenessOverlay: {
    bottom: 20,
    left: 20,
    position: "absolute",
    right: 20,
  },
  livenessText: {
    backgroundColor: "rgba(15, 23, 42, 0.75)",
    borderRadius: 12,
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "800",
    overflow: "hidden",
    paddingHorizontal: 16,
    paddingVertical: 10,
    textAlign: "center",
  },
  permissionTitle: {
    color: "#0F172A",
    fontSize: 24,
    fontWeight: "900",
    marginBottom: 20,
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
  statusBox: {
    alignItems: "center",
    backgroundColor: "#EAF2FF",
    borderRadius: 20,
    flexDirection: "row",
    padding: 16,
  },
  statusText: {
    color: "#124A9C",
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
  },
  successCard: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 32,
    elevation: 8,
    gap: 16,
    marginTop: 40,
    padding: 30,
    shadowColor: "#1677FF",
    shadowOffset: { height: 10, width: 0 },
    shadowOpacity: 0.1,
    shadowRadius: 20,
  },
  successCheck: {
    color: "#FFFFFF",
    fontSize: 32,
    fontWeight: "bold",
  },
  successDetails: {
    alignItems: "center",
    marginBottom: 10,
  },
  successIconInner: {
    alignItems: "center",
    backgroundColor: "#22C55E",
    borderRadius: 40,
    height: 60,
    justifyContent: "center",
    width: 60,
  },
  successIconOuter: {
    backgroundColor: "#DCFCE7",
    borderRadius: 50,
    padding: 10,
  },
  successName: {
    color: "#0F172A",
    fontSize: 24,
    fontWeight: "900",
    textAlign: "center",
  },
  successTime: {
    color: "#64748B",
    fontSize: 16,
    fontWeight: "600",
    marginTop: 4,
  },
  successTitle: {
    color: "#22C55E",
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
});
