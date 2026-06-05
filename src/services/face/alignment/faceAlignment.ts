import type { FaceBoundingBox, FaceLandmark } from "@/services/face/types";
import { type RgbImage, sampleBilinearToNchw } from "@/services/image/jpegTensor";

const FACE_SIZE = 112;
const FACE_AREA = FACE_SIZE * FACE_SIZE;

const ALIGNMENT_TEMPLATE: FaceLandmark[] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
  
];

function solveLinear4(matrix: Float32Array, vector: Float32Array) {
  // Gaussian elimination for a 4x4 system
  const aug = new Float32Array(4 * 5);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      aug[i * 5 + j] = matrix[i * 4 + j];
    }
    aug[i * 5 + 4] = vector[i];
  }

  for (let pivot = 0; pivot < 4; pivot += 1) {
    let maxRow = pivot;
    for (let row = pivot + 1; row < 4; row += 1) {
      if (Math.abs(aug[row * 5 + pivot]) > Math.abs(aug[maxRow * 5 + pivot])) {
        maxRow = row;
      }
    }

    if (maxRow !== pivot) {
      for (let col = 0; col < 5; col++) {
        const tmp = aug[pivot * 5 + col];
        aug[pivot * 5 + col] = aug[maxRow * 5 + col];
        aug[maxRow * 5 + col] = tmp;
      }
    }

    const div = aug[pivot * 5 + pivot] || 1e-8;
    for (let col = pivot; col < 5; col += 1) {
      aug[pivot * 5 + col] /= div;
    }

    for (let row = 0; row < 4; row += 1) {
      if (row === pivot) continue;
      const factor = aug[row * 5 + pivot];
      for (let col = pivot; col < 5; col += 1) {
        aug[row * 5 + col] -= factor * aug[pivot * 5 + col];
      }
    }
  }

  return new Float32Array([aug[4], aug[9], aug[14], aug[19]]);
}

function estimateSimilarityTransform(src: FaceLandmark[], dst: FaceLandmark[]) {
  const normMat = new Float32Array(16);
  const normVec = new Float32Array(4);

  for (let i = 0; i < src.length; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    
    // Matrix accumulation for normal equations
    normVec[0] += x * u + y * v;
    normVec[1] += -y * u + x * v;
    normVec[2] += u;
    normVec[3] += v;

    normMat[0] += x * x + y * y;
    normMat[2] += x;
    normMat[3] += y;
    
    normMat[5] += x * x + y * y;
    normMat[6] += -y;
    normMat[7] += x;
    
    normMat[10] += 1;
    normMat[15] += 1;
  }
  
  // Fill symmetric parts
  normMat[1] = 0;
  normMat[4] = 0;
  normMat[8] = normMat[2];
  normMat[9] = normMat[6];
  normMat[12] = normMat[3];
  normMat[13] = normMat[7];

  const res = solveLinear4(normMat, normVec);
  return { a: res[0], b: res[1], tx: res[2], ty: res[3] };
}

function warpAlignedFace(image: RgbImage, landmarks: FaceLandmark[]) {
  const { a, b, tx, ty } = estimateSimilarityTransform(landmarks.slice(0, 5), ALIGNMENT_TEMPLATE);
  const determinant = a * a + b * b || 1e-8;
  const output = new Float32Array(1 * 3 * FACE_AREA);

  for (let y = 0; y < FACE_SIZE; y += 1) {
    const targetRowOffset = y * FACE_SIZE;
    const shiftedY = y - ty;

    for (let x = 0; x < FACE_SIZE; x += 1) {
      const shiftedX = x - tx;
      const sourceX = (a * shiftedX + b * shiftedY) / determinant;
      const sourceY = (-b * shiftedX + a * shiftedY) / determinant;
      
      sampleBilinearToNchw(image, sourceX, sourceY, output, targetRowOffset + x, FACE_AREA);
    }
  }

  return output;
}

function cropFace(image: RgbImage, bbox: FaceBoundingBox) {
  const [top, right, bottom, left] = bbox;
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const output = new Float32Array(1 * 3 * FACE_AREA);

  const scaleX = width / Math.max(1, FACE_SIZE - 1);
  const scaleY = height / Math.max(1, FACE_SIZE - 1);

  for (let y = 0; y < FACE_SIZE; y += 1) {
    const targetRowOffset = y * FACE_SIZE;
    const sourceY = top + y * scaleY;

    for (let x = 0; x < FACE_SIZE; x += 1) {
      const sourceX = left + x * scaleX;
      sampleBilinearToNchw(image, sourceX, sourceY, output, targetRowOffset + x, FACE_AREA);
    }
  }

  return output;
}

export function buildFaceEmbeddingTensor(image: RgbImage, bbox: FaceBoundingBox, landmarks: FaceLandmark[]) {
  if (landmarks.length >= 5) {
    return warpAlignedFace(image, landmarks);
  }

  return cropFace(image, bbox);
}
