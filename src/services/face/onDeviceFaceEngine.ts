import type * as Ort from "onnxruntime-react-native";

import { buildFaceEmbeddingTensor } from "@/services/face/faceAlignment";
import { findBestEmbeddingMatch, l2Normalize } from "@/services/face/faceMath";
import { runPassiveLivenessQualityCheck } from "@/services/face/liveness";
import { getFaceModelUris } from "@/services/face/modelAssets";
import { decodeScrfdOutputs, type Detection } from "@/services/face/scrfdDetector";
import type {
  AttendanceLogRequest,
  BackendAttendanceLog,
  EnrollFaceRequest,
  EnrollFaceResponse,
  FaceEngine,
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

type LoadedRuntime = {
  ort: OrtModule;
  detectorSession: OrtSession;
  embedderSession: OrtSession;
};

let runtimePromise: Promise<LoadedRuntime> | null = null;

async function loadRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const ort = await import("onnxruntime-react-native");
      const { detectorUri, embedderUri } = await getFaceModelUris();
      const sessionOptions: Ort.InferenceSession.SessionOptions = {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
      };

      const [detectorSession, embedderSession] = await Promise.all([
        ort.InferenceSession.create(detectorUri, sessionOptions),
        ort.InferenceSession.create(embedderUri, sessionOptions),
      ]);

      return {
        ort,
        detectorSession,
        embedderSession,
      };
    })();
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

async function detectFaces(runtime: LoadedRuntime, image: RgbImage) {
  const tensorData = imageToNchwTensor(image, 320);
  const tensor = new runtime.ort.Tensor("float32", tensorData, [1, 3, 320, 320]);
  const outputs = await runtime.detectorSession.run({
    [runtime.detectorSession.inputNames[0]]: tensor,
  });

  return decodeScrfdOutputs(outputs, {
    confidenceThreshold: 0.5,
    nmsThreshold: 0.4,
    maxDetections: 8,
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

export class OnDeviceFaceEngine implements FaceEngine {
  async health(): Promise<HealthResponse> {
    await loadRuntime();

    return {
      status: "ok",
      version: "on-device-onnx-scrfd-edgeface",
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
    const detections = await detectFaces(runtime, image);
    const database = await getLocalFaceEmbeddingDatabase();
    const results: FaceRecognitionResult[] = [];

    for (const detection of detections) {
      const embedding = await generateEmbedding(runtime, image, detection);
      const match = findBestEmbeddingMatch(database, embedding, 0.45);
      const quality = runPassiveLivenessQualityCheck(detection.bbox, detection.landmarks, detection.score, image.width);

      results.push({
        person_id: match?.person_id ?? "unknown",
        name: match?.name ?? "Unknown",
        similarity: match?.similarity ?? 0,
        bbox: detection.bbox,
        score: detection.score,
        landmarks: detection.landmarks,
        engine: "on-device",
        liveness_verified: quality.verified,
        liveness_score: quality.score,
        liveness_reason: quality.reason,
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
