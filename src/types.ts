export interface VideoAsset {
  id: string;
  name: string;
  url: string;
  duration: number;
  description: string; // AI generated or user provided
}

export interface AudioAsset {
  id: string;
  name: string;
  url: string;
  duration: number;
}

export interface TimelineSegment {
  id: string;
  assetId: string;
  startTime: number; // Start time in the overall timeline
  duration: number;
  scriptSnippet: string;
  zoom?: number; // 1.0 to 1.5 for digital zoom
  transition?: 'none' | 'fade' | 'zoom-in' | 'zoom-out';
}

export interface EditProject {
  title: string;
  script: string;
  voiceover: AudioAsset | null;
  clips: VideoAsset[];
  timeline: TimelineSegment[];
}
