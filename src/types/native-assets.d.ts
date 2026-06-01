declare module "*.onnx" {
  const assetId: number;
  export default assetId;
}

declare module "base-64" {
  export function decode(input: string): string;
  export function encode(input: string): string;
}

declare module "jpeg-js" {
  export type RawImageData = {
    width: number;
    height: number;
    data: Uint8Array | Uint8ClampedArray;
  };

  export function decode(buffer: Uint8Array, options?: { useTArray?: boolean; maxMemoryUsageInMB?: number }): RawImageData;
}
