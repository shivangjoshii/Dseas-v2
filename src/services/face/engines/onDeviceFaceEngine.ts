import { buildFaceEmbeddingTensor } from "@/services/face/alignment/faceAlignment";
import {
  DETECTOR_INPUT_SIZE,
  scaleDetection,
  selectEnrollmentDetection,
} from "@/services/face/detection/detectionUtils";
import { decodeScrfdOutputs, type Detection } from "@/services/face/detection/scrfdDetector";
import {
  loadRuntime,
  runQueuedRuntimeOperation,
  type LoadedRuntime,
} from "@/services/face/engines/ortRuntime";
import { findBestEmbeddingMatch, l2Normalize } from "@/services/face/utils/faceMath";
import {
  buildMiniFasNetLivenessTensor,
  runPassiveLivenessQualityCheck,
  scoreMiniFasNetLiveness,
} from "@/services/face/liveness/liveness";
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

const DEFAULT_DETECTION_CONFIDENCE = 0.5;
const DEFAULT_MAX_DETECTIONS = 8;

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
    confThresh: options.confidenceThreshold ?? DEFAULT_DETECTION_CONFIDENCE,
    nmsThresh: 0.4,
    maxDets: options.maxDetections ?? DEFAULT_MAX_DETECTIONS,
  });
}

async function generateEmbedding(runtime: LoadedRuntime, image: RgbImage, detection: Detection) {
  const imageDetection = scaleDetection(detection, image);
  const faceTensorData = buildFaceEmbeddingTensor(image, imageDetection.bbox, imageDetection.landmarks);
  const tensor = new runtime.ort.Tensor("float32", faceTensorData, [1, 3, 112, 112]);
  const outputs = await runtime.embedderSession.run({
    [runtime.embedderSession.inputNames[0]]: tensor,
  });
  const outputName = runtime.embedderSession.outputNames[0];
  const output = outputs[outputName];
  const rawEmbedding = Array.from(output.data as Float32Array);

  return Array.from(l2Normalize(rawEmbedding));
}

async function runMiniFasNetLiveness(runtime: LoadedRuntime, image: RgbImage, detection: Detection) {
  const passiveQuality = runPassiveLivenessQualityCheck(
    detection.bbox,
    detection.landmarks,
    detection.score,
    DETECTOR_INPUT_SIZE,
  );
  const imageDetection = scaleDetection(detection, image);
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
    void getLocalFaceEmbeddingDatabase();

    return {
      status: "ok",
      version: "on-device-onnx-scrfd-minifasnet-edgeface",
    };
  }

  async detect(request: DetectFaceRequest): Promise<DetectFaceResponse> {
    return runQueuedRuntimeOperation(async (runtime) => {
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
    });
  }

  async recognizePrimary(request: RecognizeFaceRequest): Promise<RecognizeFaceResponse> {
    return runQueuedRuntimeOperation(async (runtime) => {
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

      if (!detection) {
        return {
          success: true,
          results: [],
          count: 0,
        };
      }

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
    });
  }

  async recognizeDetectedPrimary(request: RecognizeFaceRequest & { detection: FaceDetectionResult }): Promise<RecognizeFaceResponse> {
    return runQueuedRuntimeOperation(async (runtime) => {
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
    });
  }

  async enroll(request: EnrollFaceRequest): Promise<EnrollFaceResponse> {
    return runQueuedRuntimeOperation(async (runtime) => {
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

      if (!detection) {
        return {
          success: false,
          error: "No high-confidence face detected",
        };
      }

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
    });
  }

  async recognize(request: RecognizeFaceRequest): Promise<RecognizeFaceResponse> {
    return runQueuedRuntimeOperation(async (runtime) => {
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
    });
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
