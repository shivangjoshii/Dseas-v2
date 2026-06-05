import { normalizeApiBaseUrl } from "@/services/config/faceBackend";
import type {
  AttendanceLogRequest,
  BackendAttendanceLog,
  EnrollFaceRequest,
  EnrollFaceResponse,
  FaceEngine,
  HealthResponse,
  RecognizeFaceRequest,
  RecognizeFaceResponse,
} from "@/services/face/types";

type BackendFaceEngineOptions = {
  apiBaseUrl: string;
  timeoutMs?: number;
};

export class BackendFaceEngine implements FaceEngine {
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: BackendFaceEngineOptions) {
    this.apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
    this.timeoutMs = options.timeoutMs ?? 20000;
  }

  async health() {
    return this.request<HealthResponse>("/health", {
      method: "GET",
    });
  }

  async enroll(request: EnrollFaceRequest) {
    return this.request<EnrollFaceResponse>("/enroll", {
      method: "POST",
      body: JSON.stringify({
        name: request.name,
        person_id: request.personId || undefined,
        image: request.imageBase64,
      }),
    });
  }

  async recognize(request: RecognizeFaceRequest) {
    return this.request<RecognizeFaceResponse>("/recognize", {
      method: "POST",
      body: JSON.stringify({
        image: request.imageBase64,
      }),
    });
  }

  async logAttendance(request: AttendanceLogRequest) {
    return this.request<{ success: boolean; error?: string }>("/attendance", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async getAttendanceLogs(limit = 100) {
    const response = await this.request<{ success: boolean; logs: BackendAttendanceLog[]; error?: string }>(
      `/attendance/logs?limit=${encodeURIComponent(limit)}`,
      {
        method: "GET",
      },
    );

    return response.logs ?? [];
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.apiBaseUrl}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => ({}))) as T & { error?: string; success?: boolean };

      if (!response.ok || payload.success === false) {
        throw new Error(payload.error || `Face backend request failed with HTTP ${response.status}`);
      }

      return payload;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Face backend request timed out");
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
