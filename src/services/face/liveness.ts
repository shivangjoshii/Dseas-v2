import type { FaceBoundingBox, FaceLandmark } from "@/services/face/types";
import { type RgbImage, sampleBilinear } from "@/services/image/jpegTensor";

export type LivenessCheck = {
  verified: boolean;
  score: number;
  reason: string;
};

const MINIFASNET_INPUT_SIZE = 128;
const LIVE_CLASS_INDEX = 1;
const PASSIVE_LIVENESS_THRESHOLD = 0.42;

function distance(left: FaceLandmark, right: FaceLandmark) {
  return Math.hypot(left[0] - right[0], left[1] - right[1]);
}

function softmax(values: number[]) {
  const max = Math.max(...values);
  const exponents = values.map((value) => Math.exp(value - max));
  const total = exponents.reduce((sum, value) => sum + value, 0) || 1;

  return exponents.map((value) => value / total);
}

export function runPassiveLivenessQualityCheck(
  bbox: FaceBoundingBox,
  landmarks: FaceLandmark[],
  detectionScore: number,
  imageSize = 320,
): LivenessCheck {
  const [top, right, bottom, left] = bbox;
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const faceAreaRatio = (width * height) / (imageSize * imageSize);
  const centerX = (left + right) / 2 / imageSize;
  const centerY = (top + bottom) / 2 / imageSize;
  const centeredScore = 1 - Math.min(1, Math.hypot(centerX - 0.5, centerY - 0.5) * 2);
  const sizeScore = faceAreaRatio >= 0.08 && faceAreaRatio <= 0.7 ? 1 : 0.35;
  const landmarkScore =
    landmarks.length >= 5 && distance(landmarks[0], landmarks[1]) > 18 && distance(landmarks[3], landmarks[4]) > 16
      ? 1
      : 0.35;
  const score = detectionScore * 0.45 + centeredScore * 0.2 + sizeScore * 0.2 + landmarkScore * 0.15;
  const verified = score >= 0.62;

  return {
    verified,
    score,
    reason: verified
      ? "Passive quality gate passed"
      : "Face quality/liveness gate failed. Use a centered, clear, live face capture.",
  };
}

export function buildMiniFasNetLivenessTensor(image: RgbImage, bbox: FaceBoundingBox) {
  const [top, right, bottom, left] = bbox;
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const cropSize = Math.max(width, height) * 1.8;
  const cropLeft = centerX - cropSize / 2;
  const cropTop = centerY - cropSize / 2;
  const tensor = new Float32Array(1 * 3 * MINIFASNET_INPUT_SIZE * MINIFASNET_INPUT_SIZE);
  const area = MINIFASNET_INPUT_SIZE * MINIFASNET_INPUT_SIZE;

  for (let y = 0; y < MINIFASNET_INPUT_SIZE; y += 1) {
    for (let x = 0; x < MINIFASNET_INPUT_SIZE; x += 1) {
      const sourceX = cropLeft + (x / Math.max(1, MINIFASNET_INPUT_SIZE - 1)) * cropSize;
      const sourceY = cropTop + (y / Math.max(1, MINIFASNET_INPUT_SIZE - 1)) * cropSize;
      const [red, green, blue] = sampleBilinear(image, sourceX, sourceY);
      const targetIndex = y * MINIFASNET_INPUT_SIZE + x;

      tensor[targetIndex] = red / 255;
      tensor[area + targetIndex] = green / 255;
      tensor[area * 2 + targetIndex] = blue / 255;
    }
  }

  return tensor;
}

export function scoreMiniFasNetLiveness(rawOutput: ArrayLike<number>, passiveQuality: LivenessCheck): LivenessCheck {
  const logits = Array.from(rawOutput, Number);
  const probabilities = logits.length > 1 ? softmax(logits) : logits;
  const rawLiveScore = probabilities[LIVE_CLASS_INDEX] ?? probabilities[0] ?? passiveQuality.score;
  const modelScore = Math.max(0, Math.min(1, rawLiveScore));
  const advisoryScore = Math.max(modelScore, passiveQuality.score);
  const score = advisoryScore * 0.45 + passiveQuality.score * 0.55;
  const verified = passiveQuality.verified || passiveQuality.score >= PASSIVE_LIVENESS_THRESHOLD;

  return {
    verified,
    score,
    reason: verified
      ? `Offline liveness quality passed. MiniFASNet advisory ${(modelScore * 100).toFixed(1)}%.`
      : "Liveness quality failed. Use a centered, clear, live face.",
  };
}
