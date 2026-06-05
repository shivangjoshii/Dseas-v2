import { decode as decodeBase64 } from "base-64";
import jpeg from "jpeg-js";

export type RgbImage = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

type ResizeIndexMap = {
  xOffsets: Int32Array;
  yOffsets: Int32Array;
};

const resizeIndexCache = new Map<string, ResizeIndexMap>();

function getResizeIndexMap(width: number, height: number, size: number): ResizeIndexMap {
  const cacheKey = `${width}x${height}->${size}`;
  const cached = resizeIndexCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const xOffsets = new Int32Array(size);
  const yOffsets = new Int32Array(size);

  const scaleX = (width - 1) / Math.max(1, size - 1);
  const scaleY = (height - 1) / Math.max(1, size - 1);

  for (let x = 0; x < size; x += 1) {
    const sourceX = (x * scaleX + 0.5) | 0;
    xOffsets[x] = (sourceX > width - 1 ? width - 1 : sourceX) << 2;
  }

  for (let y = 0; y < size; y += 1) {
    const sourceY = (y * scaleY + 0.5) | 0;
    yOffsets[y] = (sourceY > height - 1 ? height - 1 : sourceY) * width * 4;
  }

  const indexMap = { xOffsets, yOffsets };
  resizeIndexCache.set(cacheKey, indexMap);

  return indexMap;
}

export function decodeJpegBase64(base64: string): RgbImage {
  const cleanBase64 = base64.includes(",") ? base64.split(",", 2)[1] : base64;
  const binary = decodeBase64(cleanBase64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const decoded = jpeg.decode(bytes, {
    useTArray: true,
    maxMemoryUsageInMB: 32,
  });

  return {
    width: decoded.width,
    height: decoded.height,
    data:
      decoded.data instanceof Uint8ClampedArray
        ? decoded.data
        : new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
  };
}

export function imageToNchwTensor(image: RgbImage, size: number) {
  const tensor = new Float32Array(3 * size * size);
  const area = size * size;
  const data = image.data;

  const inv128 = 1 / 128;
  const offset127 = 127.5 / 128;

  if (image.width === size && image.height === size) {
    // Fast path: Input matches target size, skip coordinate mapping
    for (let i = 0; i < area; i++) {
      const srcIdx = i << 2;
      tensor[i] = data[srcIdx] * inv128 - offset127;
      tensor[area + i] = data[srcIdx + 1] * inv128 - offset127;
      tensor[area * 2 + i] = data[srcIdx + 2] * inv128 - offset127;
    }
    return tensor;
  }

  const { xOffsets, yOffsets } = getResizeIndexMap(image.width, image.height, size);

  for (let y = 0; y < size; y += 1) {
    const sourceRowOffset = yOffsets[y];
    const targetRowOffset = y * size;

    for (let x = 0; x < size; x += 1) {
      const sourceIndex = sourceRowOffset + xOffsets[x];
      const targetIndex = targetRowOffset + x;

      tensor[targetIndex] = data[sourceIndex] * inv128 - offset127;
      tensor[area + targetIndex] = data[sourceIndex + 1] * inv128 - offset127;
      tensor[area * 2 + targetIndex] = data[sourceIndex + 2] * inv128 - offset127;
    }
  }

  return tensor;
}

export function sampleBilinear(image: RgbImage, x: number, y: number): [number, number, number] {
  const width = image.width;
  const height = image.height;
  const data = image.data;

  const clampedX = x < 0 ? 0 : x > width - 1 ? width - 1 : x;
  const clampedY = y < 0 ? 0 : y > height - 1 ? height - 1 : y;
  
  const x0 = clampedX | 0;
  const y0 = clampedY | 0;
  const x1 = x0 + 1 >= width ? x0 : x0 + 1;
  const y1 = y0 + 1 >= height ? y0 : y0 + 1;
  
  const dx = clampedX - x0;
  const dy = clampedY - y0;
  const invDx = 1 - dx;
  const invDy = 1 - dy;

  const row0 = y0 * width;
  const row1 = y1 * width;
  
  const i00 = (row0 + x0) << 2;
  const i10 = (row0 + x1) << 2;
  const i01 = (row1 + x0) << 2;
  const i11 = (row1 + x1) << 2;

  const w00 = invDx * invDy;
  const w10 = dx * invDy;
  const w01 = invDx * dy;
  const w11 = dx * dy;

  return [
    data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11,
    data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11,
    data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11,
  ];
}

/**
 * Optimized version of sampleBilinear that writes directly to a NCHW tensor.
 * This avoids array allocations and is much faster for batch processing.
 */
export function sampleBilinearToNchw(
  image: RgbImage,
  x: number,
  y: number,
  tensor: Float32Array,
  targetIndex: number,
  area: number,
  offset: number = 127.5,
  scale: number = 128
) {
  const width = image.width;
  const height = image.height;
  const data = image.data;

  const clampedX = x < 0 ? 0 : x > width - 1 ? width - 1 : x;
  const clampedY = y < 0 ? 0 : y > height - 1 ? height - 1 : y;
  
  const x0 = clampedX | 0;
  const y0 = clampedY | 0;
  const x1 = x0 + 1 >= width ? x0 : x0 + 1;
  const y1 = y0 + 1 >= height ? y0 : y0 + 1;
  
  const dx = clampedX - x0;
  const dy = clampedY - y0;
  const invDx = 1 - dx;
  const invDy = 1 - dy;

  const row0 = y0 * width;
  const row1 = y1 * width;
  
  const i00 = (row0 + x0) << 2;
  const i10 = (row0 + x1) << 2;
  const i01 = (row1 + x0) << 2;
  const i11 = (row1 + x1) << 2;

  const w00 = invDx * invDy;
  const w10 = dx * invDy;
  const w01 = invDx * dy;
  const w11 = dx * dy;

  const invScale = 1 / scale;
  const normOffset = offset / scale;

  tensor[targetIndex] = (data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11) * invScale - normOffset;
  tensor[area + targetIndex] = (data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11) * invScale - normOffset;
  tensor[area * 2 + targetIndex] = (data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11) * invScale - normOffset;
}
