import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View, type DimensionValue } from "react-native";
import { CameraView, type CameraCapturedPicture, type CameraType, useCameraPermissions } from "expo-camera";

import { ActionButton } from "@/components/ActionButton";
import { withTimeout } from "@/services/async/withTimeout";
import { OnDeviceFaceEngine } from "@/services/face/onDeviceFaceEngine";
import type { FaceDetectionResult, FaceRecognitionResult } from "@/services/face/types";
import { prepareFaceImageAsync } from "@/services/image/prepareFaceImage";

const FRAME_SIZE = 320;
const LIVE_FRAME_DELAY_MS = 60;
const OVERLAY_ANIMATION_MS = 260;
const NO_FACE_GRACE_MS = 1200;
const STATUS_UPDATE_MS = 1200;
const DETECTION_TIMEOUT_MS = 1200;
const RECOGNITION_TIMEOUT_MS = 2800;
const RECOGNITION_INTERVAL_MS = 2000;
const MAX_LIVE_DETECTIONS = 3;

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

function bboxIoU(leftBox: FaceDetectionResult["bbox"], rightBox: FaceRecognitionResult["bbox"]) {
  const top = Math.max(leftBox[0], rightBox[0]);
  const right = Math.min(leftBox[1], rightBox[1]);
  const bottom = Math.min(leftBox[2], rightBox[2]);
  const left = Math.max(leftBox[3], rightBox[3]);
  const intersectionWidth = Math.max(0, right - left);
  const intersectionHeight = Math.max(0, bottom - top);
  const intersection = intersectionWidth * intersectionHeight;
  const leftArea = Math.max(0, leftBox[1] - leftBox[3]) * Math.max(0, leftBox[2] - leftBox[0]);
  const rightArea = Math.max(0, rightBox[1] - rightBox[3]) * Math.max(0, rightBox[2] - rightBox[0]);
  const union = leftArea + rightArea - intersection;

  return union > 0 ? intersection / union : 0;
}

function attachCachedRecognitionLabels(
  detections: FaceDetectionResult[],
  cachedRecognitions: FaceRecognitionResult[],
): FaceRecognitionResult[] {
  return detections.map((detection) => {
    const bestCachedRecognition = cachedRecognitions.reduce<{
      recognition: FaceRecognitionResult;
      overlap: number;
    } | null>((best, recognition) => {
      const overlap = bboxIoU(detection.bbox, recognition.bbox);

      if (overlap < 0.18 || (best && best.overlap >= overlap)) {
        return best;
      }

      return {
        recognition,
        overlap,
      };
    }, null);
    const cached = bestCachedRecognition?.recognition;

    return {
      ...detection,
      person_id: cached?.person_id ?? "unknown",
      name: cached?.name ?? "Unknown",
      similarity: cached?.similarity ?? 0,
    };
  });
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
  const cameraRef = useRef<CameraView | null>(null);
  const localEngineRef = useRef(new OnDeviceFaceEngine());
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>("front");
  const [cameraReady, setCameraReady] = useState(false);
  const [isLive, setIsLive] = useState(true);
  const [status, setStatus] = useState("Starting local live face detection...");
  const [liveMeta, setLiveMeta] = useState({
    engine: "Local detector",
    faces: 0,
    recognition: "warming up",
  });
  const [results, setResults] = useState<FaceRecognitionResult[]>([]);
  const animationFrameRef = useRef<number | null>(null);
  const displayedResultsRef = useRef<FaceRecognitionResult[]>([]);
  const latestRecognitionsRef = useRef<FaceRecognitionResult[]>([]);
  const recognitionInFlightRef = useRef(false);
  const lastRecognitionAtRef = useRef(0);
  const recognitionStatusRef = useRef("warming up");
  const noFaceSinceRef = useRef<number | null>(null);
  const lastStatusAtRef = useRef(0);

  const setRecognitionStatus = useCallback((recognition: string) => {
    recognitionStatusRef.current = recognition;
    setLiveMeta((current) => ({
      ...current,
      recognition,
    }));
  }, []);

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
    if (!permission?.granted || !cameraReady) {
      return;
    }

    let cancelled = false;

    void withTimeout(localEngineRef.current.health(), 45000, "Local ONNX model loading timed out")
      .then(() => {
        if (!cancelled) {
          setStatus("Local model ready. Live detection running...");
          setRecognitionStatus("ready");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : "Local model failed to load");
          setRecognitionStatus("unavailable");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cameraReady, permission?.granted, setRecognitionStatus]);

  useEffect(() => {
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    function maybeRefreshRecognition(imageBase64: string) {
      if (recognitionInFlightRef.current || Date.now() - lastRecognitionAtRef.current < RECOGNITION_INTERVAL_MS) {
        return;
      }

      recognitionInFlightRef.current = true;
      lastRecognitionAtRef.current = Date.now();
      setRecognitionStatus("updating");

      void withTimeout(
        localEngineRef.current.recognizePrimary({ imageBase64 }),
        RECOGNITION_TIMEOUT_MS,
        "Local recognition timed out",
      )
        .then((response) => {
          if (cancelled) {
            return;
          }

          latestRecognitionsRef.current = response.results;
          setRecognitionStatus(response.results.length > 0 ? "matched" : "no match");
        })
        .catch((error) => {
          if (!cancelled) {
            setRecognitionStatus("delayed");

            if (Date.now() - lastStatusAtRef.current > STATUS_UPDATE_MS) {
              lastStatusAtRef.current = Date.now();
              setStatus(error instanceof Error ? error.message : "Local recognition delayed");
            }
          }
        })
        .finally(() => {
          recognitionInFlightRef.current = false;
        });
    }

    async function processFrame() {
      if (cancelled || !isLive || !permission?.granted || !cameraReady || !cameraRef.current) {
        return;
      }

      try {
        const startTime = Date.now();
        const photo = (await cameraRef.current.takePictureAsync({
          quality: 0.35,
          shutterSound: false,
          skipProcessing: false,
        })) as CameraCapturedPicture | undefined;

        if (!photo) {
          throw new Error("Camera did not return a picture");
        }

        const prepared = await prepareFaceImageAsync(photo, {
          compress: 0.35,
          size: FRAME_SIZE,
        });
        const detection = await withTimeout(
          localEngineRef.current.detect({
            imageBase64: prepared.base64,
            confidenceThreshold: 0.55,
            maxDetections: MAX_LIVE_DETECTIONS,
          }),
          DETECTION_TIMEOUT_MS,
          "Local detection timed out",
        );

        if (!cancelled) {
          const displayResults = attachCachedRecognitionLabels(detection.detections, latestRecognitionsRef.current);
          const hasFaces = displayResults.length > 0;

          if (hasFaces) {
            noFaceSinceRef.current = null;
            animateOverlayTo(displayResults);
            maybeRefreshRecognition(prepared.base64);
          } else {
            noFaceSinceRef.current ??= Date.now();

            if (Date.now() - noFaceSinceRef.current > NO_FACE_GRACE_MS) {
              animateOverlayTo([]);
            }
          }

          setLiveMeta({
            engine: "Local detector",
            faces: displayResults.length,
            recognition: recognitionStatusRef.current,
          });

          if (Date.now() - lastStatusAtRef.current > STATUS_UPDATE_MS) {
            lastStatusAtRef.current = Date.now();
            setStatus(
              `Local detect | ${displayResults.length} face${displayResults.length === 1 ? "" : "s"} | ${
                Date.now() - startTime
              }ms | recognition ${recognitionStatusRef.current}`,
            );
          }
        }
      } catch (error) {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : "Local live detection failed");
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
  }, [animateOverlayTo, cameraReady, isLive, permission?.granted, setRecognitionStatus]);

  function switchCamera() {
    setCameraReady(false);
    displayedResultsRef.current = [];
    latestRecognitionsRef.current = [];
    recognitionInFlightRef.current = false;
    lastRecognitionAtRef.current = 0;
    noFaceSinceRef.current = null;
    setRecognitionStatus("warming up");
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
            setStatus(isLive ? "Camera ready. Loading local model..." : "Camera ready.");
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
          {liveMeta.engine} | {liveMeta.faces} face{liveMeta.faces === 1 ? "" : "s"} | recognition{" "}
          {liveMeta.recognition}
        </Text>
        <Text style={styles.muted}>
          Live frames stay local on the phone. Detection runs frequently; heavier identity recognition runs separately
          and reuses the latest secure local match.
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
