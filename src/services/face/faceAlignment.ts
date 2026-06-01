import type { FaceBoundingBox, FaceLandmark } from "@/services/face/types";
import { type RgbImage, sampleBilinear } from "@/services/image/jpegTensor";

const FACE_SIZE = 112;

const ALIGNMENT_TEMPLATE: FaceLandmark[] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
  
];

function solveLinear4(matrix: number[][], vector: number[]) {
  const augmented = matrix.map((row, index) => [...row, vector[index]]);

  for (let pivot = 0; pivot < 4; pivot += 1) {
    let maxRow = pivot;

    for (let row = pivot + 1; row < 4; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[maxRow][pivot])) {
        maxRow = row;
      }
    }

    [augmented[pivot], augmented[maxRow]] = [augmented[maxRow], augmented[pivot]];

    const divisor = augmented[pivot][pivot] || 1e-8;

    for (let column = pivot; column < 5; column += 1) {
      augmented[pivot][column] /= divisor;
    }

    for (let row = 0; row < 4; row += 1) {
      if (row === pivot) {
        continue;
      }

      const factor = augmented[row][pivot];

      for (let column = pivot; column < 5; column += 1) {

        augmented[row][column] -= factor * augmented[pivot][column];
      }
    }
  }

  return augmented.map((row) => row[4]);
}

function estimateSimilarityTransform(source: FaceLandmark[], destination: FaceLandmark[]) {
  const normalMatrix = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const normalVector = [0, 0, 0, 0];

  for (let index = 0; index < source.length; index += 1) {
    const [x, y] = source[index];
    const [u, v] = destination[index];
    const rows = [
      [x, -y, 1, 0],
      [y, x, 0, 1],
    ];
    const values = [u, v];

    for (let row = 0; row < 2; row += 1) {
      for (let i = 0; i < 4; i += 1) {
        normalVector[i] += rows[row][i] * values[row];

        for (let j = 0; j < 4; j += 1) {
          normalMatrix[i][j] += rows[row][i] * rows[row][j];
        }
      }
    }
  }

  const [a, b, tx, ty] = solveLinear4(normalMatrix, normalVector);

  return { a, b, tx, ty };
}

function warpAlignedFace(image: RgbImage, landmarks: FaceLandmark[]) {
  const { a, b, tx, ty } = estimateSimilarityTransform(landmarks.slice(0, 5), ALIGNMENT_TEMPLATE);
  const determinant = a * a + b * b || 1e-8;
  const output = new Float32Array(1 * 3 * FACE_SIZE * FACE_SIZE);
  const area = FACE_SIZE * FACE_SIZE;

  for (let y = 0; y < FACE_SIZE; y += 1) {
    for (let x = 0; x < FACE_SIZE; x += 1) {
      const shiftedX = x - tx;
      const shiftedY = y - ty;
      const sourceX = (a * shiftedX + b * shiftedY) / determinant;
      const sourceY = (-b * shiftedX + a * shiftedY) / determinant;
      const [red, green, blue] = sampleBilinear(image, sourceX, sourceY);
      const targetIndex = y * FACE_SIZE + x;

      output[targetIndex] = (red - 127.5) / 128;
      output[area + targetIndex] = (green - 127.5) / 128;
      output[area * 2 + targetIndex] = (blue - 127.5) / 128;
    }
  }

  return output;
}

function cropFace(image: RgbImage, bbox: FaceBoundingBox) {
  const [top, right, bottom, left] = bbox;
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const output = new Float32Array(1 * 3 * FACE_SIZE * FACE_SIZE);
  const area = FACE_SIZE * FACE_SIZE;

  for (let y = 0; y < FACE_SIZE; y += 1) {
    for (let x = 0; x < FACE_SIZE; x += 1) {
      const sourceX = left + (x / Math.max(1, FACE_SIZE - 1)) * width;
      const sourceY = top + (y / Math.max(1, FACE_SIZE - 1)) * height;
      const [red, green, blue] = sampleBilinear(image, sourceX, sourceY);
      const targetIndex = y * FACE_SIZE + x;

      output[targetIndex] = (red - 127.5) / 128;
      output[area + targetIndex] = (green - 127.5) / 128;
      output[area * 2 + targetIndex] = (blue - 127.5) / 128;
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
