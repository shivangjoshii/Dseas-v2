import type * as Ort from "onnxruntime-react-native";

import { withTimeout } from "@/services/async/withTimeout";
import { buildFaceEmbeddingTensor } from "@/services/face/faceAlignment";
import { findBestEmbeddingMatch, l2Normalize } from "@/services/face/faceMath";
import {
  buildMiniFasNetLivenessTensor,
  runPassiveLivenessQualityCheck,
  scoreMiniFasNetLiveness,
} from "@/services/face/liveness";
import { getFaceModelUris } from "@/services/face/modelAssets";
import { decodeScrfdOutputs, type Detection } from "@/services/face/scrfdDetector";
import type {
  AttendanceLogRequest,
  BackendAttendanceLog,
  DetectFaceRequest,
  DetectFaceResponse,
  EnrollFaceRequest,
  EnrollFaceResponse,
  FaceBoundingBox,
  FaceEngine,
  FaceDetectionResult,
  FaceLandmark,
  FaceRecognitionResult,
  HealthResponse,
  RecognizeFaceRequest,
  RecognizeFaceResponse,
} from "@/services/face/types";
import { decodeJpegBase64, imageToNchwTensor, type RgbImage } from "@/services/image/jpegTensor";
import {
  getLocalFaceEmbeddingDatabase,
  saveAttendanceRecord,
  saveLocalFaceMetadata,
} from "@/services/storage/database";

type OrtModule = typeof Ort;
type OrtSession = Ort.InferenceSession;
type OrtRuntimeApi = Pick<OrtModule, "InferenceSession" | "Tensor">;

type LoadedRuntime = {
  ort: OrtRuntimeApi;
  detectorSession: OrtSession;
  embedderSession: OrtSession;
  livenessSession: OrtSession;
};

let runtimePromise: Promise<LoadedRuntime> | null = null;
const SESSION_LOAD_TIMEOUT_MS = 20000;
const RUNTIME_LOAD_TIMEOUT_MS = 45000;
const DEFAULT_DETECTION_CONFIDENCE = 0.5;
const DEFAULT_MAX_DETECTIONS = 8;
const DETECTOR_INPUT_SIZE = 320;

function resolveOrtRuntime(...candidates: unknown[]): OrtRuntimeApi {
  for (const candidate of candidates) {
    const moduleCandidate = candidate as
      | (Partial<OrtRuntimeApi> & {
          default?: Partial<OrtRuntimeApi>;
        })
      | null
      | undefined;
    const runtime = moduleCandidate?.InferenceSession?.create
      ? moduleCandidate
      : moduleCandidate?.default?.InferenceSession?.create
        ? moduleCandidate.default
        : null;

    if (runtime?.InferenceSession?.create && runtime.Tensor) {
      return {
        InferenceSession: runtime.InferenceSession,
        Tensor: runtime.Tensor,
      };
    }
  }

  throw new Error("ONNX Runtime API unavailable. Rebuild the native dev app after installing onnxruntime-react-native.");
}

async function loadRuntime() {
  if (!runtimePromise) {
    runtimePromise = withTimeout(
      (async () => {
        const reactNativeOrt = await import("onnxruntime-react-native");
        const ort = resolveOrtRuntime(reactNativeOrt);
        const { detectorUri, embedderUri, livenessUri } = await getFaceModelUris();
        const sessionOptions: Ort.InferenceSession.SessionOptions = {
          graphOptimizationLevel: "basic",
          intraOpNumThreads: 4,
          interOpNumThreads: 1,
        };

        const [detectorSession, embedderSession, livenessSession] = await Promise.all([
          withTimeout(
            ort.InferenceSession.create(detectorUri, sessionOptions),
            SESSION_LOAD_TIMEOUT_MS,
            "Detector ONNX session load timed out",
          ),
          withTimeout(
            ort.InferenceSession.create(embedderUri, sessionOptions),
            SESSION_LOAD_TIMEOUT_MS,
            "Embedding ONNX session load timed out",
          ),
          withTimeout(
            ort.InferenceSession.create(livenessUri, sessionOptions),
            SESSION_LOAD_TIMEOUT_MS,
            "MiniFASNet liveness ONNX session load timed out",
          ),
        ]);

        return {
          ort,
          detectorSession,
          embedderSession,
          livenessSession,
        };
      })(),
      RUNTIME_LOAD_TIMEOUT_MS,
      "On-device ONNX runtime load timed out",
    ).catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }

  return runtimePromise;
}

function selectEnrollmentDetection(detections: Detection[]) {
  return [...detections].sort((left, right) => {
    const leftArea = (left.bbox[1] - left.bbox[3]) * (left.bbox[2] - left.bbox[0]);
    const rightArea = (right.bbox[1] - right.bbox[3]) * (right.bbox[2] - right.bbox[0]);

    return right.score * rightArea - left.score * leftArea;
  })[0];
}

async function detectFaces(
  runtime: LoadedRuntime,
  image: RgbImage,
  options: { confidenceThreshold?: number; maxDetections?: number } = {},
) {
  const tensorData = imageToNchwTensor(image, DETECTOR_INPUT_SIZE);
  const tensor = new runtime.ort.Tensor("float32", tensorData, [
    1,
    3,
    DETECTOR_INPUT_SIZE,
    DETECTOR_INPUT_SIZE,
  ]);
  const outputs = await runtime.detectorSession.run({
    [runtime.detectorSession.inputNames[0]]: tensor,
  });

  return decodeScrfdOutputs(outputs, {
    confidenceThreshold: options.confidenceThreshold ?? DEFAULT_DETECTION_CONFIDENCE,
    nmsThreshold: 0.4,
    maxDetections: options.maxDetections ?? DEFAULT_MAX_DETECTIONS,
  });
}

function scaleBoundingBoxToImage(bbox: FaceBoundingBox, image: RgbImage): FaceBoundingBox {
  const scaleX = image.width / DETECTOR_INPUT_SIZE;
  const scaleY = image.height / DETECTOR_INPUT_SIZE;

  return [bbox[0] * scaleY, bbox[1] * scaleX, bbox[2] * scaleY, bbox[3] * scaleX];
}

function scaleLandmarksToImage(landmarks: FaceLandmark[], image: RgbImage): FaceLandmark[] {
  const scaleX = image.width / DETECTOR_INPUT_SIZE;
  const scaleY = image.height / DETECTOR_INPUT_SIZE;

  return landmarks.map(([x, y]) => [x * scaleX, y * scaleY]);
}

function scaleDetectionToImage(detection: Detection, image: RgbImage): Detection {
  if (image.width === DETECTOR_INPUT_SIZE && image.height === DETECTOR_INPUT_SIZE) {
    return detection;
  }

  return {
    ...detection,
    bbox: scaleBoundingBoxToImage(detection.bbox, image),
    landmarks: scaleLandmarksToImage(detection.landmarks, image),
  };
}

async function generateEmbedding(runtime: LoadedRuntime, image: RgbImage, detection: Detection) {
  const imageDetection = scaleDetectionToImage(detection, image);
  const faceTensorData = buildFaceEmbeddingTensor(image, imageDetection.bbox, imageDetection.landmarks);
  const tensor = new runtime.ort.Tensor("float32", faceTensorData, [1, 3, 112, 112]);
  const outputs = await runtime.embedderSession.run({
    [runtime.embedderSession.inputNames[0]]: tensor,
  });
  const outputName = runtime.embedderSession.outputNames[0];
  const output = outputs[outputName];
  const rawEmbedding = Array.from(output.data as Float32Array);

  return l2Normalize(rawEmbedding);
}

async function runMiniFasNetLiveness(runtime: LoadedRuntime, image: RgbImage, detection: Detection) {
  const passiveQuality = runPassiveLivenessQualityCheck(
    detection.bbox,
    detection.landmarks,
    detection.score,
    DETECTOR_INPUT_SIZE,
  );
  const imageDetection = scaleDetectionToImage(detection, image);
  const livenessTensorData = buildMiniFasNetLivenessTensor(image, imageDetection.bbox);
  const tensor = new runtime.ort.Tensor("float32", livenessTensorData, [1, 3, 128, 128]);
  const outputs = await runtime.livenessSession.run({
    [runtime.livenessSession.inputNames[0]]: tensor,
  });
  const outputName = runtime.livenessSession.outputNames[0];
  const output = outputs[outputName];

  return scoreMiniFasNetLiveness(output.data as ArrayLike<number>, passiveQuality);
}

async function detectionToResult(
  runtime: LoadedRuntime,
  image: RgbImage,
  detection: Detection,
  livenessMode: DetectFaceRequest["livenessMode"] = "model",
): Promise<FaceDetectionResult> {
  const liveness =
    livenessMode === "passive"
      ? runPassiveLivenessQualityCheck(detection.bbox, detection.landmarks, detection.score, DETECTOR_INPUT_SIZE)
      : await runMiniFasNetLiveness(runtime, image, detection);

  return {
    bbox: detection.bbox,
    score: detection.score,
    landmarks: detection.landmarks,
    engine: "on-device",
    liveness_verified: liveness.verified,
    liveness_score: liveness.score,
    liveness_reason: liveness.reason,
  };
}

export class OnDeviceFaceEngine implements FaceEngine {
  async health(): Promise<HealthResponse> {
    await loadRuntime();

    return {
      status: "ok",
      version: "on-device-onnx-scrfd-minifasnet-edgeface",
    };
  }

  async detect(request: DetectFaceRequest): Promise<DetectFaceResponse> {
    const runtime = await loadRuntime();
    const image = decodeJpegBase64(request.imageBase64);
    const detections = await detectFaces(runtime, image, {
      confidenceThreshold: request.confidenceThreshold,
      maxDetections: request.maxDetections,
    });
    const results: FaceDetectionResult[] = [];

    for (const detection of detections) {
      results.push(await detectionToResult(runtime, image, detection, request.livenessMode));
    }

    return {
      success: true,
      detections: results,
      count: results.length,
    };
  }

  async recognizePrimary(request: RecognizeFaceRequest): Promise<RecognizeFaceResponse> {
    const runtime = await loadRuntime();
    const image = decodeJpegBase64(request.imageBase64);
    const detections = await detectFaces(runtime, image, {
      maxDetections: 1,
    });

    if (detections.length === 0) {
      return {
        success: true,
        results: [],
        count: 0,
      };
    }

    const detection = selectEnrollmentDetection(detections);
    const detectionResult = await detectionToResult(runtime, image, detection);

    if (detectionResult.liveness_verified === false) {
      return {
        success: true,
        results: [
          {
            ...detectionResult,
            person_id: "unknown",
            name: "Liveness failed",
            similarity: 0,
          },
        ],
        count: 1,
      };
    }

    const database = await getLocalFaceEmbeddingDatabase();
    const embedding = await generateEmbedding(runtime, image, detection);
    const match = findBestEmbeddingMatch(database, embedding, 0.45);
    const results: FaceRecognitionResult[] = [
      {
        ...detectionResult,
        person_id: match?.person_id ?? "unknown",
        name: match?.name ?? "Unknown",
        similarity: match?.similarity ?? 0,
      },
    ];

    return {
      success: true,
      results,
      count: results.length,
    };
  }

  async recognizeDetectedPrimary(request: RecognizeFaceRequest & { detection: FaceDetectionResult }): Promise<RecognizeFaceResponse> {
    const runtime = await loadRuntime();
    const image = decodeJpegBase64(request.imageBase64);
    const detection: Detection = {
      bbox: request.detection.bbox,
      landmarks: request.detection.landmarks,
      score: request.detection.score,
    };
    const detectionResult = {
      ...request.detection,
      engine: "on-device" as const,
      liveness_verified: request.detection.liveness_verified !== false,
    };

    if (detectionResult.liveness_verified === false) {
      return {
        success: true,
        results: [
          {
            ...detectionResult,
            person_id: "unknown",
            name: "Liveness failed",
            similarity: 0,
          },
        ],
        count: 1,
      };
    }

    const [database, embedding] = await Promise.all([
      getLocalFaceEmbeddingDatabase(),
      generateEmbedding(runtime, image, detection),
    ]);
    const match = findBestEmbeddingMatch(database, embedding, 0.45);

    return {
      success: true,
      results: [
        {
          ...detectionResult,
          person_id: match?.person_id ?? "unknown",
          name: match?.name ?? "Unknown",
          similarity: match?.similarity ?? 0,
        },
      ],
      count: 1,
    };
  }

  async enroll(request: EnrollFaceRequest): Promise<EnrollFaceResponse> {
    const runtime = await loadRuntime();
    const image = decodeJpegBase64(request.imageBase64);
    const detections = await detectFaces(runtime, image, {
      maxDetections: 1,
    });

    if (detections.length === 0) {
      return {
        success: false,
        error: "No face detected",
      };
    }

    const detection = selectEnrollmentDetection(detections);
    const liveness = await runMiniFasNetLiveness(runtime, image, detection);

    if (!liveness.verified) {
      return {
        success: false,
        error: liveness.reason,
      };
    }

    const embedding = await generateEmbedding(runtime, image, detection);
    const personId = request.personId || request.name;
    await saveLocalFaceMetadata(personId, request.name, embedding);

    return {
      success: true,
      person_id: personId,
    };
  }

  async recognize(request: RecognizeFaceRequest): Promise<RecognizeFaceResponse> {
    const runtime = await loadRuntime();
    const image = decodeJpegBase64(request.imageBase64);
    const detections = await detectFaces(runtime, image, {
      maxDetections: request.maxFaces ?? 1,
    });
    let database: Awaited<ReturnType<typeof getLocalFaceEmbeddingDatabase>> | null = null;
    const results: FaceRecognitionResult[] = [];

    for (const detection of detections) {
      const detectionResult = await detectionToResult(runtime, image, detection);

      if (detectionResult.liveness_verified === false) {
        results.push({
          ...detectionResult,
          person_id: "unknown",
          name: "Liveness failed",
          similarity: 0,
        });
        continue;
      }

      const embedding = await generateEmbedding(runtime, image, detection);
      database ??= await getLocalFaceEmbeddingDatabase();
      const match = findBestEmbeddingMatch(database, embedding, 0.45);

      results.push({
        ...detectionResult,
        person_id: match?.person_id ?? "unknown",
        name: match?.name ?? "Unknown",
        similarity: match?.similarity ?? 0,
      });
    }

    return {
      success: true,
      results,
      count: results.length,
    };
  }

  async logAttendance(request: AttendanceLogRequest): Promise<{ success: boolean; error?: string }> {
    await saveAttendanceRecord({
      ...request,
      source: "local",
      synced: false,
    });

    return { success: true };
  }

  async getAttendanceLogs(_limit?: number): Promise<BackendAttendanceLog[]> {
    return [];
  }
}
