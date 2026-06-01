export const DEFAULT_FACE_API_BASE_URL = "http://127.0.0.1:5000/api/v1";

export function normalizeApiBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

export function getDeviceBackendHint() {
  return [
    "Android emulator: http://10.0.2.2:5000/api/v1",
    "iOS simulator: http://127.0.0.1:5000/api/v1",
    "Physical phone: http://YOUR_COMPUTER_LAN_IP:5000/api/v1",
  ].join("\n");
}
