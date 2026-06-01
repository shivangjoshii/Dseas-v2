import type * as Ort from "onnxruntime-react-native";

import { withTimeout } from "@/services/async/withTimeout";
import { buildFaceEmbeddingTensor } from "@/services/face/faceAlignment";
import { findBestEmbeddingMatch, l2Normalize } from "@/services/face/faceMath";
import { runPassiveLivenessQualityCheck } from "@/services/face/liveness";
import { getFaceModelUris } from "@/services/face/modelAssets";
import { decodeScrfdOutputs, type Detection } from "@/services/face/scrfdDetector";
import type {
  AttendanceLogRequest,
  BackendAttendanceLog,
  DetectFaceRequest,
  DetectFaceResponse,
  EnrollFaceRequest,
  EnrollFaceResponse,
  FaceEngine,
  FaceDetectionResult,
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
};

let runtimePromise: Promise<LoadedRuntime> | null = null;
const SESSION_LOAD_TIMEOUT_MS = 20000;
const RUNTIME_LOAD_TIMEOUT_MS = 45000;
const DEFAULT_DETECTION_CONFIDENCE = 0.5;
const DEFAULT_MAX_DETECTIONS = 8;

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
        const { detectorUri, embedderUri } = await getFaceModelUris();
        const sessionOptions: Ort.InferenceSession.SessionOptions = {
          graphOptimizationLevel: "basic",
          intraOpNumThreads: 4,
          interOpNumThreads: 1,
        };

        const detectorSession = await withTimeout(
          ort.InferenceSession.create(detectorUri, sessionOptions),
          SESSION_LOAD_TIMEOUT_MS,
          "Detector ONNX session load timed out",
        );
        const embedderSession = await withTimeout(
          ort.InferenceSession.create(embedderUri, sessionOptions),
          SESSION_LOAD_TIMEOUT_MS,
          "Embedding ONNX session load timed out",
        );

        return {
          ort,
          detectorSession,
          embedderSession,
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
  const tensorData = imageToNchwTensor(image, 320);
  const tensor = new runtime.ort.Tensor("float32", tensorData, [1, 3, 320, 320]);
  const outputs = await runtime.detectorSession.run({
    [runtime.detectorSession.inputNames[0]]: tensor,
  });

  return decodeScrfdOutputs(outputs, {
    confidenceThreshold: options.confidenceThreshold ?? DEFAULT_DETECTION_CONFIDENCE,
    nmsThreshold: 0.4,
    maxDetections: options.maxDetections ?? DEFAULT_MAX_DETECTIONS,
  });
}

async function generateEmbedding(runtime: LoadedRuntime, image: RgbImage, detection: Detection) {
  const faceTensorData = buildFaceEmbeddingTensor(image, detection.bbox, detection.landmarks);
  const tensor = new runtime.ort.Tensor("float32", faceTensorData, [1, 3, 112, 112]);
  const outputs = await runtime.embedderSession.run({
    [runtime.embedderSession.inputNames[0]]: tensor,
  });
  const outputName = runtime.embedderSession.outputNames[0];
  const output = outputs[outputName];
  const rawEmbedding = Array.from(output.data as Float32Array);

  return l2Normalize(rawEmbedding);
}

function detectionToResult(detection: Detection, imageWidth: number): FaceDetectionResult {
  const quality = runPassiveLivenessQualityCheck(detection.bbox, detection.landmarks, detection.score, imageWidth);

  return {
    bbox: detection.bbox,
    score: detection.score,
    landmarks: detection.landmarks,
    engine: "on-device",
    liveness_verified: quality.verified,
    liveness_score: quality.score,
    liveness_reason: quality.reason,
  };
}

export class OnDeviceFaceEngine implements FaceEngine {
  async health(): Promise<HealthResponse> {
    await loadRuntime();

    return {
      status: "ok",
      version: "on-device-onnx-scrfd-edgeface",
    };
  }

  async detect(request: DetectFaceRequest): Promise<DetectFaceResponse> {
    const runtime = await loadRuntime();
    const image = decodeJpegBase64(request.imageBase64);
    const detections = await detectFaces(runtime, image, {
      confidenceThreshold: request.confidenceThreshold,
      maxDetections: request.maxDetections,
    });
    const results = detections.map((detection) => detectionToResult(detection, image.width));

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
    const database = await getLocalFaceEmbeddingDatabase();
    const embedding = await generateEmbedding(runtime, image, detection);
    const match = findBestEmbeddingMatch(database, embedding, 0.45);
    const detectionResult = detectionToResult(detection, image.width);
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

  async enroll(request: EnrollFaceRequest): Promise<EnrollFaceResponse> {
    const runtime = await loadRuntime();
    const image = decodeJpegBase64(request.imageBase64);
    const detections = await detectFaces(runtime, image);

    if (detections.length === 0) {
      return {
        success: false,
        error: "No face detected",
      };
    }

    const detection = selectEnrollmentDetection(detections);
    const quality = runPassiveLivenessQualityCheck(detection.bbox, detection.landmarks, detection.score, image.width);

    if (!quality.verified) {
      return {
        success: false,
        error: quality.reason,
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
      maxDetections: request.maxFaces,
    });
    const database = await getLocalFaceEmbeddingDatabase();
    const results: FaceRecognitionResult[] = [];

    for (const detection of detections) {
      const embedding = await generateEmbedding(runtime, image, detection);
      const match = findBestEmbeddingMatch(database, embedding, 0.45);
      const detectionResult = detectionToResult(detection, image.width);

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
