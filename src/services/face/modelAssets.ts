import { Asset } from "expo-asset";

import detectorModelAsset from "../../../assets/models/scrfd_500m_gnkps_v2.onnx";
import embedderModelAsset from "../../../assets/models/edgeface_xs_gamma_06.onnx";

async function resolveBundledAssetUri(assetModule: number) {
  const asset = Asset.fromModule(assetModule);
  await asset.downloadAsync();

  return asset.localUri ?? asset.uri;
}

export async function getFaceModelUris() {
  const [detectorUri, embedderUri] = await Promise.all([
    resolveBundledAssetUri(detectorModelAsset),
    resolveBundledAssetUri(embedderModelAsset),
  ]);

  return {
    detectorUri,
    embedderUri,
  };
}
