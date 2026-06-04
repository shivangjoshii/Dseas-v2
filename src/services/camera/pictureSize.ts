type ParsedPictureSize = {
  area: number;
  height: number;
  raw: string;
  width: number;
};

function parsePictureSize(size: string): ParsedPictureSize | null {
  const match = size.match(/^(\d+)x(\d+)$/);

  if (!match) {
    return null;
  }

  const width = Number(match[1]);
  const height = Number(match[2]);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return {
    area: width * height,
    height,
    raw: size,
    width,
  };
}

export function pickRealtimePictureSize(sizes: string[], minimumShortSide = 480) {
  const parsedSizes = sizes
    .map(parsePictureSize)
    .filter((size): size is ParsedPictureSize => Boolean(size))
    .sort((left, right) => left.area - right.area);

  return (
    parsedSizes.find((size) => Math.min(size.width, size.height) >= minimumShortSide)?.raw ??
    parsedSizes[0]?.raw
  );
}
