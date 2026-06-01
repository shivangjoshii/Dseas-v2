import type { FaceBoundingBox, FaceLandmark } from "@/services/face/types";

export type LivenessCheck = {
  verified: boolean;
  score: number;
  reason: string;
};

function distance(left: FaceLandmark, right: FaceLandmark) {
  return Math.hypot(left[0] - right[0], left[1] - right[1]);
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
