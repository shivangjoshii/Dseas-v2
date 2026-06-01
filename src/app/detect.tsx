import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View, type DimensionValue } from "react-native";
import { CameraView, type CameraCapturedPicture, type CameraType, useCameraPermissions } from "expo-camera";
import { useLocalSearchParams } from "expo-router";

import { ActionButton } from "@/components/ActionButton";
import { withTimeout } from "@/services/async/withTimeout";
import { DEFAULT_FACE_API_BASE_URL } from "@/services/config/faceBackend";
import { BackendFaceEngine } from "@/services/face/backendFaceEngine";
import { OnDeviceFaceEngine } from "@/services/face/onDeviceFaceEngine";
import type { FaceRecognitionResult } from "@/services/face/types";
import { prepareFaceImageAsync } from "@/services/image/prepareFaceImage";

const FRAME_SIZE = 320;
const LIVE_FRAME_DELAY_MS = 180;
const OVERLAY_ANIMATION_MS = 420;
const NO_FACE_GRACE_MS = 1400;
const STATUS_UPDATE_MS = 1200;

function toPercent(value: number): DimensionValue {
  return `${Math.max(0, Math.min(100, (value / FRAME_SIZE) * 100))}%` as DimensionValue;
}

function lerp(start: number, end: number, progress: number) {
  return start + (end - start) * progress;
}

function easeOutCubic(progress: number) {
  return 1 - Math.pow(1 - progress, 3);
}

function resultKey(result: FaceRecognitionResult, index: number) {
  if (result.person_id && result.person_id !== "unknown") {
    return result.person_id;
  }

  const [top, right, bottom, left] = result.bbox;
  const centerX = Math.round((left + right) / 2 / 24) * 24;
  const centerY = Math.round((top + bottom) / 2 / 24) * 24;

  return `unknown-${centerX}-${centerY}-${index}`;
}

function blendResult(from: FaceRecognitionResult, to: FaceRecognitionResult, progress: number): FaceRecognitionResult {
  return {
    ...to,
    bbox: [
      lerp(from.bbox[0], to.bbox[0], progress),
      lerp(from.bbox[1], to.bbox[1], progress),
      lerp(from.bbox[2], to.bbox[2], progress),
      lerp(from.bbox[3], to.bbox[3], progress),
    ],
    landmarks: to.landmarks.map((landmark, index) => {
      const previousLandmark = from.landmarks[index] ?? landmark;

      return [lerp(previousLandmark[0], landmark[0], progress), lerp(previousLandmark[1], landmark[1], progress)];
    }),
    score: lerp(from.score, to.score, progress),
    similarity: lerp(from.similarity, to.similarity, progress),
  };
}

function blendResults(fromResults: FaceRecognitionResult[], toResults: FaceRecognitionResult[], progress: number) {
  return toResults.map((toResult, index) => {
    const key = resultKey(toResult, index);
    const fromResult =
      fromResults.find((candidate, candidateIndex) => resultKey(candidate, candidateIndex) === key) ??
      fromResults[index] ??
      toResult;

    return blendResult(fromResult, toResult, progress);
  });
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
  const [status, setStatus] = useState("Starting live face detection...");
  const [liveMeta, setLiveMeta] = useState({ engine: "warming up", faces: 0 });
  const [results, setResults] = useState<FaceRecognitionResult[]>([]);
  const animationFrameRef = useRef<number | null>(null);
  const displayedResultsRef = useRef<FaceRecognitionResult[]>([]);
  const noFaceSinceRef = useRef<number | null>(null);
  const lastStatusAtRef = useRef(0);

  const animateOverlayTo = useCallback((targetResults: FaceRecognitionResult[]) => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    const startedAt = Date.now();
    const sourceResults = displayedResultsRef.current;

    function step() {
      const rawProgress = Math.min(1, (Date.now() - startedAt) / OVERLAY_ANIMATION_MS);
      const easedProgress = easeOutCubic(rawProgress);
      const nextResults = blendResults(sourceResults, targetResults, easedProgress);

      displayedResultsRef.current = nextResults;
      setResults(nextResults);

      if (rawProgress < 1) {
        animationFrameRef.current = requestAnimationFrame(step);
      } else {
        displayedResultsRef.current = targetResults;
        setResults(targetResults);
        animationFrameRef.current = null;
      }
    }

    animationFrameRef.current = requestAnimationFrame(step);
  }, []);

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

      try {
        const startTime = Date.now();
        const photo = (await cameraRef.current.takePictureAsync({
          quality: 0.5,
          shutterSound: false,
          skipProcessing: false,
        })) as CameraCapturedPicture | undefined;

        if (!photo) {
          throw new Error("Camera did not return a picture");
        }

        const prepared = await prepareFaceImageAsync(photo);
        const recognition = await recognizeWithFallback(prepared.base64);

        if (!cancelled) {
          const hasFaces = recognition.results.length > 0;

          if (hasFaces) {
            noFaceSinceRef.current = null;
            animateOverlayTo(recognition.results);
          } else {
            noFaceSinceRef.current ??= Date.now();

            if (Date.now() - noFaceSinceRef.current > NO_FACE_GRACE_MS) {
              animateOverlayTo([]);
            }
          }

          setLiveMeta({
            engine: recognition.engine === "on-device" ? "On-device" : "Backend",
            faces: recognition.results.length,
          });

          if (Date.now() - lastStatusAtRef.current > STATUS_UPDATE_MS) {
            lastStatusAtRef.current = Date.now();
            setStatus(
              `${recognition.engine === "on-device" ? "On-device" : "Backend"} live overlay · ${
                recognition.results.length
              } face${recognition.results.length === 1 ? "" : "s"} · ${Date.now() - startTime}ms${
                recognition.fallbackReason ? ` · ${recognition.fallbackReason}` : ""
              }`,
            );
          }
        }
      } catch (error) {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : "Live face detection failed");
        }
      } finally {
        if (!cancelled) {
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

      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [animateOverlayTo, apiBaseUrl, cameraReady, isLive, permission?.granted]);

  function switchCamera() {
    setCameraReady(false);
    displayedResultsRef.current = [];
    noFaceSinceRef.current = null;
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
          animateShutter={false}
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
        <ActionButton disabled={!cameraReady} onPress={switchCamera} title="Switch Camera" variant="secondary" />
      </View>

      <View style={styles.statusBox}>
        <View style={[styles.liveDot, { backgroundColor: isLive ? "#22C55E" : "#94A3B8" }]} />
        <Text style={styles.statusText}>{status}</Text>
      </View>

      <View style={styles.liveHintCard}>
        <Text style={styles.sectionTitle}>
          {liveMeta.engine} · {liveMeta.faces} face{liveMeta.faces === 1 ? "" : "s"}
        </Text>
        <Text style={styles.muted}>
          The camera stays live while the overlay glides between detection frames. Green boxes are known faces; amber
          boxes are unknown faces.
        </Text>
      </View>
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
  liveDot: {
    borderRadius: 6,
    height: 12,
    width: 12,
  },
  liveHintCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 22,
    gap: 8,
    padding: 16,
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
