import type * as Ort from "onnxruntime-react-native";
import { NativeModules } from "react-native";

import { withTimeout } from "@/services/async/withTimeout";
import { getFaceModelUris } from "@/services/face/models/modelAssets";

export type OrtModule = typeof Ort;
export type OrtSession = Ort.InferenceSession;
export type OrtRuntimeApi = Pick<OrtModule, "InferenceSession" | "Tensor">;

export type LoadedRuntime = {
  ort: OrtRuntimeApi;
  detectorSession: OrtSession;
  embedderSession: OrtSession;
  livenessSession: OrtSession;
};

let runtimePromise: Promise<LoadedRuntime> | null = null;
let runtimeOperationChain = Promise.resolve();
const SESSION_LOAD_TIMEOUT_MS = 20000;
const RUNTIME_LOAD_TIMEOUT_MS = 45000;

function resolveOrtRuntime(...candidates: unknown[]): OrtRuntimeApi {
  for (const candidate of candidates) {
    const moduleCandidate = candidate as
      | (Partial<OrtRuntimeApi> & {
          default?: Partial<OrtRuntimeApi>;
        })
      | null
      | undefined;
    const runtime = moduleCandidate?.InferenceSession?.create
      ? moduleCandidate
      : moduleCandidate?.default?.InferenceSession?.create
        ? moduleCandidate.default
        : null;

    if (runtime?.InferenceSession?.create && runtime.Tensor) {
      return {
        InferenceSession: runtime.InferenceSession,
        Tensor: runtime.Tensor,
      };
    }
  }

  throw new Error("ONNX Runtime API unavailable. Rebuild the native dev app after installing onnxruntime-react-native.");
}

function assertOnnxRuntimeNativeModuleAvailable() {
  const nativeModule = NativeModules.Onnxruntime as { install?: unknown } | null | undefined;
  const alreadyInstalled = typeof (globalThis as { OrtApi?: unknown }).OrtApi !== "undefined";

  if (!alreadyInstalled && typeof nativeModule?.install !== "function") {
    throw new Error(
      "On-device ONNX native module is not linked in this Android build. Rebuild the app after applying the native ONNX registration, or use backend fallback.",
    );
  }
}

export async function loadRuntime() {
  if (!runtimePromise) {
    runtimePromise = withTimeout(
      (async () => {
        assertOnnxRuntimeNativeModuleAvailable();
        const reactNativeOrt = await import("onnxruntime-react-native");
        const ort = resolveOrtRuntime(reactNativeOrt);
        const { detectorUri, embedderUri, livenessUri } = await getFaceModelUris();
        const sessionOptions: Ort.InferenceSession.SessionOptions = {
          graphOptimizationLevel: "basic",
          intraOpNumThreads: 4,
          interOpNumThreads: 1,
        };

        const detectorSession = await withTimeout(
          ort.InferenceSession.create(detectorUri, sessionOptions),
          SESSION_LOAD_TIMEOUT_MS,
          "Detector ONNX session load timed out",
        );
        const embedderSession = await withTimeout(
          ort.InferenceSession.create(embedderUri, sessionOptions),
          SESSION_LOAD_TIMEOUT_MS,
          "Embedding ONNX session load timed out",
        );
        const livenessSession = await withTimeout(
          ort.InferenceSession.create(livenessUri, sessionOptions),
          SESSION_LOAD_TIMEOUT_MS,
          "MiniFASNet liveness ONNX session load timed out",
        );

        return {
          ort,
          detectorSession,
          embedderSession,
          livenessSession,
        };
      })(),
      RUNTIME_LOAD_TIMEOUT_MS,
      "On-device ONNX runtime load timed out",
    ).catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }

  return runtimePromise;
}

export function runQueuedRuntimeOperation<T>(operation: (runtime: LoadedRuntime) => Promise<T>) {
  const queuedOperation = runtimeOperationChain.then(
    async () => operation(await loadRuntime()),
    async () => operation(await loadRuntime()),
  );

  runtimeOperationChain = queuedOperation.then(
    () => undefined,
    () => undefined,
  );

  return queuedOperation;
}
