import { type CameraCapturedPicture } from "expo-camera";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";

export type PreparedFaceImage = {
  uri: string;
  base64: string;
  width: number;
  height: number;
};

export type PrepareFaceImageOptions = {
  compress?: number;
  size?: number;
};

export async function prepareFaceImageAsync(
  photo: CameraCapturedPicture,
  options: PrepareFaceImageOptions = {},
): Promise<PreparedFaceImage> {
  const size = options.size ?? 320;
  const width = photo.width || 320;
  const height = photo.height || 320;
  const cropSize = Math.min(width, height);
  const originX = Math.max(0, Math.floor((width - cropSize) / 2));
  const originY = Math.max(0, Math.floor((height - cropSize) / 2));

  const manipulated = await manipulateAsync(
    photo.uri,
    [
      {
        crop: {
          originX,
          originY,
          width: cropSize,
          height: cropSize,
        },
      },
      {
        resize: {
          width: size,
          height: size,
        },
      },
    ],
    {
      base64: true,
      compress: options.compress ?? 0.6,
      format: SaveFormat.JPEG,
    },
  );

  if (!manipulated.base64) {
    throw new Error("Could not generate base64 image for face recognition");
  }

  return {
    uri: manipulated.uri,
    base64: manipulated.base64,
    width: manipulated.width,
    height: manipulated.height,
  };
}
