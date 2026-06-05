import type { FaceBoundingBox, FaceLandmark } from "@/services/face/types";

export type Detection = {
  bbox: FaceBoundingBox;
  score: number;
  landmarks: FaceLandmark[];
};

type TensorLike = {
  data: Float32Array | number[];
};

const INPUT_SIZE = 320;
const STRIDES = [8, 16, 32] as const;
const ANCHORS_PER_LOCATION = 2;

const centersCache = new Map<number, Float32Array>();

function getCenters(stride: number): Float32Array {
  const cachedCenters = centersCache.get(stride);

  if (cachedCenters) {
    return cachedCenters;
  }

  const featureMapHeight = INPUT_SIZE / stride;
  const featureMapWidth = INPUT_SIZE / stride;

  const centers = new Float32Array(
    featureMapHeight * featureMapWidth * ANCHORS_PER_LOCATION * 2,
  );

  let index = 0;

  for (let y = 0; y < featureMapHeight; y++) {
    for (let x = 0; x < featureMapWidth; x++) {
      for (let anchor = 0; anchor < ANCHORS_PER_LOCATION; anchor++) {
        centers[index++] = x * stride;
        centers[index++] = y * stride;
      }
    }
  }

  centersCache.set(stride, centers);

  return centers;
}

function getTensorData(
  outputs: Record<string, unknown>,
  tensorName: string,
): Float32Array | number[] {
  const tensor = outputs[tensorName] as TensorLike | undefined;

  if (!tensor) {
    throw new Error(`Detector output missing: ${tensorName}`);
  }

  return tensor.data;
}

function calculateIoU(
  firstBox: [number, number, number, number],
  secondBox: [number, number, number, number],
): number {
  const intersectionLeft = Math.max(firstBox[0], secondBox[0]);
  const intersectionTop = Math.max(firstBox[1], secondBox[1]);
  const intersectionRight = Math.min(firstBox[2], secondBox[2]);
  const intersectionBottom = Math.min(firstBox[3], secondBox[3]);

  const intersectionWidth = Math.max(
    0,
    intersectionRight - intersectionLeft,
  );

  const intersectionHeight = Math.max(
    0,
    intersectionBottom - intersectionTop,
  );

  const intersectionArea =
    intersectionWidth * intersectionHeight;

  const firstArea =
    Math.max(0, firstBox[2] - firstBox[0]) *
    Math.max(0, firstBox[3] - firstBox[1]);

  const secondArea =
    Math.max(0, secondBox[2] - secondBox[0]) *
    Math.max(0, secondBox[3] - secondBox[1]);

  const unionArea =
    firstArea + secondArea - intersectionArea;

  return intersectionArea / Math.max(1e-6, unionArea);
}

function runNms(
  boxes: [number, number, number, number][],
  scores: number[],
  iouThreshold: number,
  maxDetections: number,
): number[] {
  const sortedIndices = scores
    .map((_, index) => index)
    .sort((a, b) => scores[b] - scores[a]);

  const keptIndices: number[] = [];

  for (const candidateIndex of sortedIndices) {
    if (keptIndices.length >= maxDetections) {
      break;
    }

    const overlapsExistingDetection = keptIndices.some(
      (keptIndex) =>
        calculateIoU(
          boxes[candidateIndex],
          boxes[keptIndex],
        ) > iouThreshold,
    );

    if (!overlapsExistingDetection) {
      keptIndices.push(candidateIndex);
    }
  }

  return keptIndices;
}

export function decodeScrfdOutputs(
  outputs: Record<string, unknown>,
  options: {
    confThresh?: number;
    nmsThresh?: number;
    maxDets?: number;
  } = {},
): Detection[] {
  const confidenceThreshold = options.confThresh ?? 0.5;
  const nmsThreshold = options.nmsThresh ?? 0.4;
  const maxDetections = options.maxDets ?? 8;

  const decodedBoxes: [number, number, number, number][] = [];
  const decodedScores: number[] = [];
  const decodedLandmarks: FaceLandmark[][] = [];

  for (const stride of STRIDES) {
    const centers = getCenters(stride);

    const scoreTensor = getTensorData(
      outputs,
      `score_${stride}`,
    );

    const bboxTensor = getTensorData(
      outputs,
      `bbox_${stride}`,
    );

    const landmarkTensor = getTensorData(
      outputs,
      `kps_${stride}`,
    );

    for (let detectionIndex = 0; detectionIndex < scoreTensor.length; detectionIndex++) {
      const score = Number(scoreTensor[detectionIndex]);

      if (score < confidenceThreshold) {
        continue;
      }

      const centerX = centers[detectionIndex * 2];
      const centerY = centers[detectionIndex * 2 + 1];

      const bboxIndex = detectionIndex * 4;

      const left =
        centerX -
        Number(bboxTensor[bboxIndex]) * stride;

      const top =
        centerY -
        Number(bboxTensor[bboxIndex + 1]) * stride;

      const right =
        centerX +
        Number(bboxTensor[bboxIndex + 2]) * stride;

      const bottom =
        centerY +
        Number(bboxTensor[bboxIndex + 3]) * stride;

      const landmarks: FaceLandmark[] = [];

      const landmarkIndex = detectionIndex * 10;

      for (let point = 0; point < 5; point++) {
        landmarks.push([
          Number(
          landmarkTensor[landmarkIndex + point * 2], ) *
            stride +
            centerX,
          Number(
            landmarkTensor[landmarkIndex + point * 2 + 1],
          ) *
            stride +
            centerY,
        ]);
      }

      decodedBoxes.push([
        Math.max(0, Math.min(INPUT_SIZE, left)),
        Math.max(0, Math.min(INPUT_SIZE, top)),
        Math.max(0, Math.min(INPUT_SIZE, right)),
        Math.max(0, Math.min(INPUT_SIZE, bottom)),
      ]);

      decodedScores.push(score);
      decodedLandmarks.push(landmarks);
    }
  }

  const keptIndices = runNms(
    decodedBoxes,
    decodedScores,
    nmsThreshold,
    maxDetections,
  );

  return keptIndices.map<Detection>((index) => {
    const [left, top, right, bottom] =
      decodedBoxes[index];

    return {
      bbox: [top, right, bottom, left],
      score: decodedScores[index],
      landmarks: decodedLandmarks[index],
    };
  });
}