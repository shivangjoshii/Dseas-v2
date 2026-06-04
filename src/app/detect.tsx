import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View, type DimensionValue } from "react-native";
import { CameraView, type CameraCapturedPicture, type CameraType, useCameraPermissions } from "expo-camera";

import { ActionButton } from "@/components/ActionButton";
import { withTimeout } from "@/services/async/withTimeout";
import { pickRealtimePictureSize } from "@/services/camera/pictureSize";
import { OnDeviceFaceEngine } from "@/services/face/onDeviceFaceEngine";
import type { FaceDetectionResult, FaceRecognitionResult } from "@/services/face/types";
import { prepareFaceImageAsync } from "@/services/image/prepareFaceImage";

const FRAME_SIZE = 320;
const LIVE_CAPTURE_SIZE = 224;
const LIVE_FRAME_DELAY_MS = 0;
const NO_FACE_GRACE_MS = 1200;
const STATUS_UPDATE_MS = 650;
const DETECTION_TIMEOUT_MS = 1200;
const RECOGNITION_TIMEOUT_MS = 1400;
const RECOGNITION_INTERVAL_MS = 1200;
const MAX_LIVE_DETECTIONS = 1;
const MIN_OVERLAY_SMOOTHING_ALPHA = 0.62;
const MAX_OVERLAY_SMOOTHING_ALPHA = 0.9;
const MAX_PREDICTION_MS = 320;
const MAX_PREDICTION_GAIN = 0.82;
const HEAD_TURN_RANGE_THRESHOLD = 0.06;
const ACTIVE_LIVENESS_MIN_SAMPLES = 2;

type ActiveLivenessTracker = {
  maxYaw: number | null;
  minYaw: number | null;
  samples: number;
  verified: boolean;
};

function createActiveLivenessTracker(): ActiveLivenessTracker {
  return {
    maxYaw: null,
    minYaw: null,
    samples: 0,
    verified: false,
  };
}

function toPercent(value: number): DimensionValue {
  return `${Math.max(0, Math.min(100, (value / FRAME_SIZE) * 100))}%` as DimensionValue;
}

function lerp(start: number, end: number, progress: number) {
  return start + (end - start) * progress;
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

function bboxCenter(result: FaceRecognitionResult) {
  const [top, right, bottom, left] = result.bbox;

  return {
    height: bottom - top,
    width: right - left,
    x: (left + right) / 2,
    y: (top + bottom) / 2,
  };
}

function getOverlayBlendAlpha(fromResults: FaceRecognitionResult[], toResults: FaceRecognitionResult[]) {
  if (fromResults.length === 0 || toResults.length === 0) {
    return MAX_OVERLAY_SMOOTHING_ALPHA;
  }

  let maxMotion = 0;

  for (let index = 0; index < toResults.length; index += 1) {
    const toResult = toResults[index];
    const key = resultKey(toResult, index);
    const fromResult =
      fromResults.find((candidate, candidateIndex) => resultKey(candidate, candidateIndex) === key) ??
      fromResults[index];

    if (!fromResult) {
      maxMotion = Math.max(maxMotion, 48);
      continue;
    }

    const fromCenter = bboxCenter(fromResult);
    const toCenter = bboxCenter(toResult);
    const centerMotion = Math.hypot(toCenter.x - fromCenter.x, toCenter.y - fromCenter.y);
    const sizeMotion = Math.abs(toCenter.width - fromCenter.width) + Math.abs(toCenter.height - fromCenter.height);

    maxMotion = Math.max(maxMotion, centerMotion + sizeMotion * 0.35);
  }

  if (maxMotion > 42) {
    return MAX_OVERLAY_SMOOTHING_ALPHA;
  }

  if (maxMotion > 18) {
    return 0.78;
  }

  return MIN_OVERLAY_SMOOTHING_ALPHA;
}

function clampFrame(value: number) {
  return Math.max(0, Math.min(FRAME_SIZE, value));
}

function predictResult(
  current: FaceRecognitionResult,
  previous: FaceRecognitionResult | undefined,
  elapsedMs: number,
  deltaMs: number,
): FaceRecognitionResult {
  if (!previous || deltaMs <= 0) {
    return current;
  }

  const predictionGain = Math.min(MAX_PREDICTION_GAIN, Math.min(elapsedMs, MAX_PREDICTION_MS) / deltaMs);

  return {
    ...current,
    bbox: current.bbox.map((value, index) => clampFrame(value + (value - previous.bbox[index]) * predictionGain)) as FaceRecognitionResult["bbox"],
    landmarks: current.landmarks.map((landmark, index) => {
      const previousLandmark = previous.landmarks[index] ?? landmark;

      return [
        clampFrame(landmark[0] + (landmark[0] - previousLandmark[0]) * predictionGain),
        clampFrame(landmark[1] + (landmark[1] - previousLandmark[1]) * predictionGain),
      ];
    }),
  };
}

function predictResults(
  currentResults: FaceRecognitionResult[],
  previousResults: FaceRecognitionResult[],
  elapsedMs: number,
  deltaMs: number,
) {
  return currentResults.map((current, index) => {
    const key = resultKey(current, index);
    const previous =
      previousResults.find((candidate, candidateIndex) => resultKey(candidate, candidateIndex) === key) ??
      previousResults[index];

    return predictResult(current, previous, elapsedMs, deltaMs);
  });
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

function RecognitionOverlay({ activeLivenessVerified, mirrored, results }: { activeLivenessVerified: boolean; mirrored: boolean; results: FaceRecognitionResult[] }) {
  return (
    <View pointerEvents="none" style={styles.overlay}>
      {results.map((result, resultIndex) => {
        const [top, right, bottom, left] = result.bbox;
        const isKnown = result.person_id !== "unknown";
        const isLiveFace = result.liveness_verified !== false && activeLivenessVerified;
        const displayLeft = mirrored ? FRAME_SIZE - right : left;
        const color = !activeLivenessVerified ? "#1677FF" : isKnown ? "#22C55E" : "#F59E0B";
        const livenessLabel = activeLivenessVerified ? "live" : "turn head";
        const label = `${result.name || "Unknown"} - ${livenessLabel} (${(result.score * 100).toFixed(1)}%)`;

        return (
          <View
            key={`box-${result.person_id}-${resultIndex}`}
            style={[
              styles.faceBox,
              {
                borderColor: color,
                height: toPercent(bottom - top),
                left: toPercent(displayLeft),
                top: toPercent(top),
                width: toPercent(right - left),
                opacity: isLiveFace ? 1 : 0.94,
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
                backgroundColor: !activeLivenessVerified ? "#1677FF" : isKnown ? "#22C55E" : "#FFFFFF",
                left: toPercent(mirrored ? FRAME_SIZE - x : x),
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
  const [pictureSize, setPictureSize] = useState<string | undefined>();
  const [isLive, setIsLive] = useState(true);
  const [status, setStatus] = useState("Starting local live face detection...");
  const [liveMeta, setLiveMeta] = useState({
    engine: "Local detector + liveness",
    faces: 0,
    liveness: "turn head left/right",
    recognition: "warming up",
  });
  const [results, setResults] = useState<FaceRecognitionResult[]>([]);
  const overlayFrameRef = useRef<number | null>(null);
  const displayedResultsRef = useRef<FaceRecognitionResult[]>([]);
  const previousTargetResultsRef = useRef<FaceRecognitionResult[]>([]);
  const previousTargetAtRef = useRef(0);
  const targetResultsRef = useRef<FaceRecognitionResult[]>([]);
  const targetAtRef = useRef(0);
  const latestRecognitionsRef = useRef<FaceRecognitionResult[]>([]);
  const recognitionInFlightRef = useRef(false);
  const lastRecognitionAtRef = useRef(0);
  const recognitionStatusRef = useRef("warming up");
  const noFaceSinceRef = useRef<number | null>(null);
  const lastStatusAtRef = useRef(0);
  const activeLivenessRef = useRef(createActiveLivenessTracker());
  const [activeLivenessVerified, setActiveLivenessVerified] = useState(false);

  const setRecognitionStatus = useCallback((recognition: string) => {
    if (recognitionStatusRef.current === recognition) {
      return;
    }

    recognitionStatusRef.current = recognition;
    setLiveMeta((current) => ({
      ...current,
      recognition,
    }));
  }, []);

  const updateActiveLiveness = useCallback((face: FaceDetectionResult | null) => {
    if (!face) {
      activeLivenessRef.current = createActiveLivenessTracker();
      setActiveLivenessVerified(false);
      return "show face";
    }

    const yaw = estimateHeadYaw(face);
    const tracker = activeLivenessRef.current;

    tracker.samples += 1;
    tracker.minYaw = tracker.minYaw === null ? yaw : Math.min(tracker.minYaw, yaw);
    tracker.maxYaw = tracker.maxYaw === null ? yaw : Math.max(tracker.maxYaw, yaw);

    const yawRange = tracker.maxYaw - tracker.minYaw;
    const verified = tracker.samples >= ACTIVE_LIVENESS_MIN_SAMPLES && yawRange >= HEAD_TURN_RANGE_THRESHOLD;

    if (verified && !tracker.verified) {
      tracker.verified = true;
      setActiveLivenessVerified(true);
    }

    if (tracker.verified) {
      return "active live verified";
    }

    return yaw < 0 ? "turn head right" : "turn head left";
  }, []);

  const updateOverlayTo = useCallback((targetResults: FaceRecognitionResult[]) => {
    previousTargetResultsRef.current = targetResultsRef.current;
    previousTargetAtRef.current = targetAtRef.current;
    targetResultsRef.current = targetResults;
    targetAtRef.current = Date.now();

    if (targetResults.length === 0) {
      displayedResultsRef.current = [];
      setResults([]);
    }
  }, []);

  const configureFastPictureSize = useCallback(async () => {
    try {
      const availableSizes = await cameraRef.current?.getAvailablePictureSizesAsync();
      const fastSize = pickRealtimePictureSize(availableSizes ?? []);

      if (fastSize) {
        setPictureSize(fastSize);
      }
    } catch {
      setPictureSize(undefined);
    }
  }, []);

  useEffect(() => {
    if (!isLive) {
      return;
    }

    let cancelled = false;

    function tick() {
      const targetResults = targetResultsRef.current;

      if (targetResults.length > 0) {
        const now = Date.now();
        const predictedResults = predictResults(
          targetResults,
          previousTargetResultsRef.current,
          now - targetAtRef.current,
          targetAtRef.current - previousTargetAtRef.current,
        );
        const nextResults =
          displayedResultsRef.current.length > 0
            ? blendResults(
                displayedResultsRef.current,
                predictedResults,
                getOverlayBlendAlpha(displayedResultsRef.current, predictedResults),
              )
            : predictedResults;

        displayedResultsRef.current = nextResults;
        setResults(nextResults);
      }

      if (!cancelled) {
        overlayFrameRef.current = requestAnimationFrame(tick);
      }
    }

    overlayFrameRef.current = requestAnimationFrame(tick);

    return () => {
      cancelled = true;

      if (overlayFrameRef.current) {
        cancelAnimationFrame(overlayFrameRef.current);
        overlayFrameRef.current = null;
      }
    };
  }, [isLive]);

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

    function maybeRefreshRecognition(imageBase64: string, detection: FaceRecognitionResult) {
      if (recognitionInFlightRef.current || Date.now() - lastRecognitionAtRef.current < RECOGNITION_INTERVAL_MS) {
        return;
      }

      recognitionInFlightRef.current = true;
      lastRecognitionAtRef.current = Date.now();
      setRecognitionStatus("updating");

      void withTimeout(
        localEngineRef.current.recognizeDetectedPrimary({ detection, imageBase64, maxFaces: 1 }),
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
          quality: 0.14,
          shutterSound: false,
          skipProcessing: true,
        })) as CameraCapturedPicture | undefined;

        if (!photo) {
          throw new Error("Camera did not return a picture");
        }

        const prepared = await prepareFaceImageAsync(photo, {
          compress: 0.16,
          size: LIVE_CAPTURE_SIZE,
        });
        const detection = await withTimeout(
          localEngineRef.current.detect({
            imageBase64: prepared.base64,
            confidenceThreshold: 0.55,
            livenessMode: "passive",
            maxDetections: MAX_LIVE_DETECTIONS,
          }),
          DETECTION_TIMEOUT_MS,
          "Local detection timed out",
        );

        if (!cancelled) {
          const displayResults = attachCachedRecognitionLabels(detection.detections, latestRecognitionsRef.current);
          const hasFaces = displayResults.length > 0;
          let livenessStatus = activeLivenessRef.current.verified ? "active live verified" : "turn head left/right";

          if (hasFaces) {
            noFaceSinceRef.current = null;
            livenessStatus = updateActiveLiveness(displayResults[0]);
            updateOverlayTo(displayResults);

            if (activeLivenessRef.current.verified) {
              maybeRefreshRecognition(prepared.base64, displayResults[0]);
            } else {
              setRecognitionStatus("waiting liveness");
            }
          } else {
            noFaceSinceRef.current ??= Date.now();

            if (Date.now() - noFaceSinceRef.current > NO_FACE_GRACE_MS) {
              livenessStatus = updateActiveLiveness(null);
              updateOverlayTo([]);
            }
          }

          setLiveMeta({
            engine: "Local detector + liveness",
            faces: displayResults.length,
            liveness: livenessStatus,
            recognition: recognitionStatusRef.current,
          });

          if (Date.now() - lastStatusAtRef.current > STATUS_UPDATE_MS) {
            lastStatusAtRef.current = Date.now();
            setStatus(
              `Local detect | ${displayResults.length} face${displayResults.length === 1 ? "" : "s"} | ${
                Date.now() - startTime
              }ms | liveness ${livenessStatus}`,
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

    };
  }, [cameraReady, isLive, permission?.granted, setRecognitionStatus, updateActiveLiveness, updateOverlayTo]);

  function switchCamera() {
    setCameraReady(false);
    setPictureSize(undefined);
    displayedResultsRef.current = [];
    previousTargetResultsRef.current = [];
    previousTargetAtRef.current = 0;
    targetResultsRef.current = [];
    targetAtRef.current = 0;
    latestRecognitionsRef.current = [];
    recognitionInFlightRef.current = false;
    lastRecognitionAtRef.current = 0;
    noFaceSinceRef.current = null;
    activeLivenessRef.current = createActiveLivenessTracker();
    setActiveLivenessVerified(false);
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
          ref={cameraRef}
          facing={facing}
          onCameraReady={() => {
            setCameraReady(true);
            void configureFastPictureSize();
            setStatus(isLive ? "Camera ready. Loading local model..." : "Camera ready.");
          }}
          pictureSize={pictureSize}
          style={styles.camera}
        />
        <RecognitionOverlay activeLivenessVerified={activeLivenessVerified} mirrored={facing === "front"} results={results} />
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
        <Text style={styles.livenessText}>Liveness: {liveMeta.liveness}</Text>
        <Text style={styles.muted}>
          Turn your head slightly left and right. Frames stay offline; recognition starts only after active liveness passes.
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
  livenessText: {
    color: "#1677FF",
    fontSize: 14,
    fontWeight: "900",
    lineHeight: 20,
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
