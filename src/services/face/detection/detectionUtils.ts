import type { Detection } from "@/services/face/detection/scrfdDetector";
import type { FaceBoundingBox, FaceLandmark } from "@/services/face/types";
import type { RgbImage } from "@/services/image/jpegTensor";

export const DETECTOR_INPUT_SIZE = 320;

export function getBoundingBoxWidth(
  [, right, , left]: FaceBoundingBox,
): number {
  return right - left;
}

export function getBoundingBoxHeight(
  [top, , bottom]: FaceBoundingBox,
): number {
  return bottom - top;
}

export function getBoundingBoxArea(
  bbox: FaceBoundingBox,
): number {
  return getBoundingBoxWidth(bbox) * getBoundingBoxHeight(bbox);
}

export function selectEnrollmentDetection(
  detections: Detection[],
): Detection | undefined {
  const MIN_CONFIDENCE = 0.8;

  let best: Detection | undefined;
  let largestArea = 0;

  for (const detection of detections) {
    if (detection.score < MIN_CONFIDENCE) {
      continue;
    }

    const area = getBoundingBoxArea(detection.bbox);

    if (!best || area > largestArea) {
      best = detection;
      largestArea = area;
    }
  }

  return best;
}

export function scaleBoundingBox(
  [top, right, bottom, left]: FaceBoundingBox,
  image: RgbImage,
): FaceBoundingBox {
  const widthScale = image.width / DETECTOR_INPUT_SIZE;
  const heightScale = image.height / DETECTOR_INPUT_SIZE;

  return [
    top * heightScale,
    right * widthScale,
    bottom * heightScale,
    left * widthScale,
  ];
}

export function scaleLandmarks(
  landmarks: FaceLandmark[],
  image: RgbImage,
): FaceLandmark[] {
  const widthScale = image.width / DETECTOR_INPUT_SIZE;
  const heightScale = image.height / DETECTOR_INPUT_SIZE;

  return landmarks.map(([x, y]) => [
    x * widthScale,
    y * heightScale,
  ]);
}

export function scaleDetection(
  detection: Detection,
  image: RgbImage,
): Detection {
  if (
    image.width === DETECTOR_INPUT_SIZE &&
    image.height === DETECTOR_INPUT_SIZE
  ) {
    return detection;
  }

  return {
    ...detection,
    bbox: scaleBoundingBox(detection.bbox, image),
    landmarks: scaleLandmarks(detection.landmarks, image),
  };
}
