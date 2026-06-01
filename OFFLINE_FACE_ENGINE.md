# Offline Face Engine

This React Native app now contains the offline-first face recognition stack that mirrors the Python backend engine.

## What Runs Offline

The app bundles the same ONNX models used by the backend package:

```text
assets/models/scrfd_500m_gnkps_v2.onnx
assets/models/edgeface_xs_gamma_06.onnx
```

Offline recognition flow:

```text
Camera capture
  -> center crop + resize to 320x320 JPEG
  -> decode JPEG locally
  -> SCRFD ONNX face detection
  -> landmark-based 112x112 face alignment
  -> EdgeFace ONNX 512-d embedding
  -> cosine similarity against local SQLite embeddings
  -> passive liveness/quality gate
  -> save attendance to local SQLite queue
```

No internet is required for:

- local enrollment
- local recognition
- local attendance marking
- viewing local buffered attendance

Internet/backend is only required for:

- backend fallback during development
- mirroring enrollments to backend
- syncing buffered attendance records
- future AWS cloud sync

## Native Build Requirement

This engine uses:

```text
onnxruntime-react-native
```

That is native code. It cannot run inside Expo Go.

Use a development/native build:

```powershell
npx expo run:android
```

or:

```powershell
npx expo run:ios
```

For EAS:

```powershell
npx eas build --profile development --platform android
```

Then start Metro for the development build:

```powershell
npx expo start --dev-client
```

## Important Files

```text
src/services/face/onDeviceFaceEngine.ts
```

Loads bundled ONNX models and runs local enroll/recognize.

```text
src/services/face/scrfdDetector.ts
```

Decodes SCRFD outputs into face boxes and landmarks.

```text
src/services/face/faceAlignment.ts
```

Builds the aligned 112x112 face tensor for the embedding model.

```text
src/services/image/jpegTensor.ts
```

Decodes JPEG base64 and converts pixels into normalized ONNX tensors.

```text
src/services/storage/database.ts
```

Stores local embeddings and attendance queue in SQLite.

```text
src/services/sync/syncService.ts
```

Uploads unsynced local attendance records when internet/backend is available.

## Current Liveness Status

The backend did not contain a true liveness model. It only hardcoded:

```text
liveness_verified = true
```

The mobile app improves this slightly with a passive quality/liveness gate:

- detection confidence
- face size
- face centering
- landmark geometry

This helps reject poor captures, but it is not a full anti-spoofing model.

For production-grade liveness, add a dedicated anti-spoof/liveness ONNX or TFLite model and plug it into:

```text
src/services/face/liveness.ts
```

## Backend Compatibility

The app still supports backend mode/fallback:

```text
POST /api/v1/enroll
POST /api/v1/recognize
POST /api/v1/attendance
GET  /api/v1/attendance/logs
```

But the main production path is local-first:

```text
on-device engine first
backend/cloud sync later
```

## Model Notes

Detector:

```text
scrfd_500m_gnkps_v2.onnx
input:  [1, 3, 320, 320]
output: score_8, score_16, score_32, bbox_8, bbox_16, bbox_32, kps_8, kps_16, kps_32
```

Embedder:

```text
edgeface_xs_gamma_06.onnx
input:  [1, 3, 112, 112]
output: [1, 512]
```

Embeddings are L2-normalized before saving/matching.

## Production Hardening Still Recommended

Before shipping broadly:

- test on low-end Android phones
- tune threshold values with real user data
- add a dedicated liveness/anti-spoofing model
- encrypt local SQLite records if attendance data is sensitive
- add device IDs and signed sync payloads
- add AWS batch sync endpoints
- add conflict handling for cloud/user embedding updates

