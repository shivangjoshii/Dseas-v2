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
const ANCHORS = 2;

const centersByStride = new Map<number, [number, number][]>();

function getCenters(stride: number) {
  const cached = centersByStride.get(stride);

  if (cached) {
    return cached;
  }

  const centers: [number, number][] = [];
  const height = INPUT_SIZE / stride;
  const width = INPUT_SIZE / stride;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let anchor = 0; anchor < ANCHORS; anchor += 1) {
        centers.push([x * stride, y * stride]);
      }
    }
  }

  centersByStride.set(stride, centers);
  return centers;
}

function tensorData(outputs: Record<string, unknown>, name: string) {
  const tensor = outputs[name] as TensorLike | undefined;

  if (!tensor) {
    throw new Error(`Detector output missing: ${name}`);
  }

  return tensor.data;
}

function intersectionOverUnion(left: [number, number, number, number], right: [number, number, number, number]) {
  const x1 = Math.max(left[0], right[0]);
  const y1 = Math.max(left[1], right[1]);
  const x2 = Math.min(left[2], right[2]);
  const y2 = Math.min(left[3], right[3]);
  const width = Math.max(0, x2 - x1);
  const height = Math.max(0, y2 - y1);
  const intersection = width * height;
  const leftArea = Math.max(0, left[2] - left[0]) * Math.max(0, left[3] - left[1]);
  const rightArea = Math.max(0, right[2] - right[0]) * Math.max(0, right[3] - right[1]);

  return intersection / Math.max(1e-6, leftArea + rightArea - intersection);
}

function nonMaximumSuppression(
  boxes: [number, number, number, number][],
  scores: number[],
  threshold: number,
  maxDetections: number,
) {
  const order = scores.map((score, index) => ({ score, index })).sort((left, right) => right.score - left.score);
  const keep: number[] = [];

  for (const candidate of order) {
    if (keep.length >= maxDetections) {
      break;
    }

    const overlapsExisting = keep.some((keptIndex) => intersectionOverUnion(boxes[candidate.index], boxes[keptIndex]) > threshold);

    if (!overlapsExisting) {
      keep.push(candidate.index);
    }
  }

  return keep;
}

export function decodeScrfdOutputs(
  outputs: Record<string, unknown>,
  options: {
    confidenceThreshold?: number;
    nmsThreshold?: number;
    maxDetections?: number;
  } = {},
) {
  const confidenceThreshold = options.confidenceThreshold ?? 0.5;
  const nmsThreshold = options.nmsThreshold ?? 0.4;
  const maxDetections = options.maxDetections ?? 8;
  const boxes: [number, number, number, number][] = [];
  const scores: number[] = [];
  const landmarks: FaceLandmark[][] = [];

  for (const stride of STRIDES) {
    const strideCenters = getCenters(stride);
    const scoreData = tensorData(outputs, `score_${stride}`);
    const bboxData = tensorData(outputs, `bbox_${stride}`);
    const kpsData = tensorData(outputs, `kps_${stride}`);

    for (let index = 0; index < scoreData.length; index += 1) {
      const score = Number(scoreData[index]);

      if (score < confidenceThreshold) {
        continue;
      }

      const center = strideCenters[index];
      const bboxOffset = index * 4;
      const x1 = center[0] - Number(bboxData[bboxOffset]) * stride;
      const y1 = center[1] - Number(bboxData[bboxOffset + 1]) * stride;
      const x2 = center[0] + Number(bboxData[bboxOffset + 2]) * stride;
      const y2 = center[1] + Number(bboxData[bboxOffset + 3]) * stride;

      const faceLandmarks: FaceLandmark[] = [];
      const keypointOffset = index * 10;

      for (let point = 0; point < 5; point += 1) {
        faceLandmarks.push([
          Number(kpsData[keypointOffset + point * 2]) * stride + center[0],
          Number(kpsData[keypointOffset + point * 2 + 1]) * stride + center[1],
        ]);
      }

      boxes.push([
        Math.max(0, Math.min(INPUT_SIZE, x1)),
        Math.max(0, Math.min(INPUT_SIZE, y1)),
        Math.max(0, Math.min(INPUT_SIZE, x2)),
        Math.max(0, Math.min(INPUT_SIZE, y2)),
      ]);
      scores.push(score);
      landmarks.push(faceLandmarks);
    }
  }

  const keep = nonMaximumSuppression(boxes, scores, nmsThreshold, maxDetections);

  return keep.map<Detection>((index) => {
    const [x1, y1, x2, y2] = boxes[index];

    return {
      bbox: [y1, x2, y2, x1],
      score: scores[index],
      landmarks: landmarks[index],
    };
  });
}
