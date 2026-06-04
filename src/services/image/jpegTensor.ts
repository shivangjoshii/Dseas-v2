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

  for (let x = 0; x < size; x += 1) {
    const sourceX = Math.min(width - 1, Math.round((x / Math.max(1, size - 1)) * (width - 1)));
    xOffsets[x] = sourceX * 4;
  }

  for (let y = 0; y < size; y += 1) {
    const sourceY = Math.min(height - 1, Math.round((y / Math.max(1, size - 1)) * (height - 1)));
    yOffsets[y] = sourceY * width * 4;
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
  const tensor = new Float32Array(1 * 3 * size * size);
  const area = size * size;
  const { xOffsets, yOffsets } = getResizeIndexMap(image.width, image.height, size);

  for (let y = 0; y < size; y += 1) {
    const sourceRowOffset = yOffsets[y];

    for (let x = 0; x < size; x += 1) {
      const sourceIndex = sourceRowOffset + xOffsets[x];
      const targetIndex = y * size + x;

      tensor[targetIndex] = (image.data[sourceIndex] - 127.5) / 128;
      tensor[area + targetIndex] = (image.data[sourceIndex + 1] - 127.5) / 128;
      tensor[area * 2 + targetIndex] = (image.data[sourceIndex + 2] - 127.5) / 128;
    }
  }

  return tensor;
}

export function sampleBilinear(image: RgbImage, x: number, y: number) {
  const clampedX = Math.max(0, Math.min(image.width - 1, x));
  const clampedY = Math.max(0, Math.min(image.height - 1, y));
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);
  const dx = clampedX - x0;
  const dy = clampedY - y0;

  const topLeft = (y0 * image.width + x0) * 4;
  const topRight = (y0 * image.width + x1) * 4;
  const bottomLeft = (y1 * image.width + x0) * 4;
  const bottomRight = (y1 * image.width + x1) * 4;

  const output = [0, 0, 0];

  for (let channel = 0; channel < 3; channel += 1) {
    const top = image.data[topLeft + channel] * (1 - dx) + image.data[topRight + channel] * dx;
    const bottom = image.data[bottomLeft + channel] * (1 - dx) + image.data[bottomRight + channel] * dx;
    output[channel] = top * (1 - dy) + bottom * dy;
  }

  return output as [number, number, number];
}
