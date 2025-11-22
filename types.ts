export interface ScriptLine {
  id: string;
  originalText: string;
  spokenText: string; // The script line (text before |)
  imagePrompt: string; // The prompt (text after |)
  status: 'pending' | 'generating' | 'completed' | 'failed';
  imageData?: string; // Base64 data
  imageFileName?: string;
  batchId?: number; // To track which batch/key generated this
  timestamp?: string; // ISO string of completion
  error?: string;
}

export interface TimelineEntry {
  id: string;
  scriptLineId: string;
  startTime: number; // seconds
  endTime: number; // seconds
  text: string;
  image: string; // Base64 or URL
}

export interface ManifestEntry {
  script_line: string;
  pic_prompt: string;
  filename: string;
  status: string;
  api_key_batch: number | undefined;
  timestamp: string | undefined;
}

export interface ApiKeySession {
  key: string;
  limit: number;
  used: number;
  isValid: boolean;
  batchId: number;
}

export const DEFAULT_STYLE = "Whiteboard illustration showing a child reaching for food with curiosity glow-lines and a crossed-out eye icon above. Clean outlines, pastel colors. No shadows, no 3D.";
export const MIN_IMAGE_DURATION = 0.8;
export const FADE_IN_DURATION = 0.5;

export enum AppStage {
  SETUP = 'SETUP',
  SCRIPT_INPUT = 'SCRIPT_INPUT',
  IMAGE_GENERATION = 'IMAGE_GENERATION',
  AUDIO_SYNC = 'AUDIO_SYNC',
  RENDERING = 'RENDERING',
  COMPLETED = 'COMPLETED',
}
