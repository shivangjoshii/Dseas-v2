export type FaceBoundingBox = [top: number, right: number, bottom: number, left: number];

export type FaceLandmark = [x: number, y: number];

export type RecognitionPersonId = string;

export type FaceDetectionResult = {
  bbox: FaceBoundingBox;
  score: number;
  landmarks: FaceLandmark[];
  engine?: "backend" | "on-device";
  liveness_verified?: boolean;
  liveness_score?: number;
  liveness_reason?: string;
};

export type FaceRecognitionResult = FaceDetectionResult & {
  person_id: RecognitionPersonId;
  name: string;
  similarity: number;
};

export type DetectFaceRequest = {
  imageBase64: string;
  confidenceThreshold?: number;
  maxDetections?: number;
};

export type DetectFaceResponse = {
  success: boolean;
  detections: FaceDetectionResult[];
  count: number;
  error?: string;
};

export type RecognizeFaceRequest = {
  imageBase64: string;
  maxFaces?: number;
};

export type RecognizeFaceResponse = {
  success: boolean;
  results: FaceRecognitionResult[];
  count: number;
  error?: string;
};

export type EnrollFaceRequest = {
  name: string;
  personId?: string;
  imageBase64: string;
};

export type EnrollFaceResponse = {
  success: boolean;
  person_id?: string;
  error?: string;
};

export type AttendanceLogRequest = {
  person_id: string;
  name: string;
  confidence: number;
  liveness_verified: boolean;
  location: string;
};

export type BackendAttendanceLog = {
  id: number;
  person_id: string;
  name: string;
  confidence: number;
  liveness_verified: number | boolean;
  location: string;
  timestamp: string;
};

export type HealthResponse = {
  status: string;
  version: string;
};

export interface FaceEngine {
  health(): Promise<HealthResponse>;
  enroll(request: EnrollFaceRequest): Promise<EnrollFaceResponse>;
  recognize(request: RecognizeFaceRequest): Promise<RecognizeFaceResponse>;
  logAttendance(request: AttendanceLogRequest): Promise<{ success: boolean; error?: string }>;
  getAttendanceLogs(limit?: number): Promise<BackendAttendanceLog[]>;
}
