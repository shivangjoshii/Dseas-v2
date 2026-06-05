import type { FaceBoundingBox, FaceLandmark } from "@/services/face/types";
import { type RgbImage, sampleBilinearToNchw } from "@/services/image/jpegTensor";

export type LivenessCheck = {
  verified: boolean;
  score: number;
  reason: string;
};

const MINIFASNET_INPUT_SIZE = 128;
const MINIFASNET_AREA = MINIFASNET_INPUT_SIZE * MINIFASNET_INPUT_SIZE;

const LIVE_CLASS_INDEX = 1;

const PASSIVE_LIVENESS_THRESHOLD = 0.42;
const PASSIVE_VERIFICATION_THRESHOLD = 0.62;

const MIN_EYE_DISTANCE = 18;
const MIN_MOUTH_DISTANCE = 16;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function getBoundingBoxWidth([
  ,
  right,
  ,
  left,
]: FaceBoundingBox): number {
  return Math.max(1, right - left);
}

function getBoundingBoxHeight([
  top,
  ,
  bottom,
]: FaceBoundingBox): number {
  return Math.max(1, bottom - top);
}

function distance(
  first: FaceLandmark,
  second: FaceLandmark,
): number {
  return Math.hypot(
    first[0] - second[0],
    first[1] - second[1],
  );
}

function softmax(values: ArrayLike<number>): Float32Array {
  const count = values.length;

  let maxValue = -Infinity;

  for (let i = 0; i < count; i++) {
    if (values[i] > maxValue) {
      maxValue = values[i];
    }
  }

  const probabilities = new Float32Array(count);

  let sum = 0;

  for (let i = 0; i < count; i++) {
    const value = Math.exp(values[i] - maxValue);

    probabilities[i] = value;
    sum += value;
  }

  const inverseSum = 1 / (sum || 1);

  for (let i = 0; i < count; i++) {
    probabilities[i] *= inverseSum;
  }

  return probabilities;
}

export function runPassiveLivenessQualityCheck(
  bbox: FaceBoundingBox,
  landmarks: FaceLandmark[],
  detectionScore: number,
  imageSize = 320,
): LivenessCheck {
  const [top, right, bottom, left] = bbox;

  const faceWidth = getBoundingBoxWidth(bbox);
  const faceHeight = getBoundingBoxHeight(bbox);

  const faceArea = faceWidth * faceHeight;
  const imageArea = imageSize * imageSize;

  const faceRatio = faceArea / imageArea;

  const faceCenterX = (left + right) / 2;
  const faceCenterY = (top + bottom) / 2;

  const normalizedCenterX = faceCenterX / imageSize;
  const normalizedCenterY = faceCenterY / imageSize;

  const centerDistance = Math.hypot(
    normalizedCenterX - 0.5,
    normalizedCenterY - 0.5,
  );

  const centerScore =
    1 - Math.min(1, centerDistance * 2);

  const sizeScore =
    faceRatio >= 0.08 && faceRatio <= 0.7
      ? 1
      : 0.35;

  const hasValidLandmarks =
    landmarks.length >= 5 &&
    distance(landmarks[0], landmarks[1]) >
      MIN_EYE_DISTANCE &&
    distance(landmarks[3], landmarks[4]) >
      MIN_MOUTH_DISTANCE;

  const landmarkScore = hasValidLandmarks
    ? 1
    : 0.35;

  const score =
    detectionScore * 0.45 +
    centerScore * 0.2 +
    sizeScore * 0.2 +
    landmarkScore * 0.15;

  const verified =
    score >= PASSIVE_VERIFICATION_THRESHOLD;

  return {
    verified,
    score: clamp01(score),
    reason: verified
      ? "Passive quality gate passed"
      : "Face quality/liveness gate failed. Use a centered, clear, live face capture.",
  };
}

export function buildMiniFasNetLivenessTensor(
  image: RgbImage,
  bbox: FaceBoundingBox,
): Float32Array {
  const [top, right, bottom, left] = bbox;

  const faceWidth = getBoundingBoxWidth(bbox);
  const faceHeight = getBoundingBoxHeight(bbox);

  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;

  const cropSize =
    Math.max(faceWidth, faceHeight) * 1.8;

  const cropLeft = centerX - cropSize / 2;
  const cropTop = centerY - cropSize / 2;

  const tensor = new Float32Array(
    3 * MINIFASNET_AREA,
  );

  const scale =
    cropSize /
    Math.max(1, MINIFASNET_INPUT_SIZE - 1);

  for (let y = 0; y < MINIFASNET_INPUT_SIZE; y++) {
    const rowOffset = y * MINIFASNET_INPUT_SIZE;
    const sourceY = cropTop + y * scale;

    for (let x = 0; x < MINIFASNET_INPUT_SIZE; x++) {
      const sourceX = cropLeft + x * scale;

      sampleBilinearToNchw(
        image,
        sourceX,
        sourceY,
        tensor,
        rowOffset + x,
        MINIFASNET_AREA,
        0,
        255,
      );
    }
  }

  return tensor;
}

export function scoreMiniFasNetLiveness(
  rawOutput: ArrayLike<number>,
  passiveResult: LivenessCheck,
): LivenessCheck {
  const probabilities =
    rawOutput.length > 1
      ? softmax(rawOutput)
      : rawOutput;

  const liveProbability =
    probabilities[LIVE_CLASS_INDEX] ??
    probabilities[0] ??
    passiveResult.score;

  const modelScore = clamp01(liveProbability);

  const combinedScore =
    Math.max(modelScore, passiveResult.score) *
      0.45 +
    passiveResult.score * 0.55;

  const verified =
    passiveResult.verified ||
    passiveResult.score >=
      PASSIVE_LIVENESS_THRESHOLD;

  return {
    verified,
    score: clamp01(combinedScore),
    reason: verified
      ? `Offline liveness quality passed. MiniFASNet advisory ${(modelScore * 100).toFixed(1)}%.`
      : "Liveness quality failed. Use a centered, clear, live face.",
  };
}