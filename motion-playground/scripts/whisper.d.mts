/** 见 whisper.mjs */
export const MODELS: Record<string, { file: string; sha256: string; size: number; note: string }>;
export const MODEL_DIR: string;
export const LANGS: string[];
export function whichBin(name: string, env?: Record<string, string | undefined>, platform?: string): string | null;
export function findWhisperBin(env?: Record<string, string | undefined>, platform?: string): string | null;
export function findModel(root: string, env?: Record<string, string | undefined>): string | null;
export function whisperArgs(o: { model: string; wav: string; outBase: string; lang?: string; threads?: number }): string[];
export function parseProgress(text: string): number | null;
export function setupHint(o: { bin: string | null; model: string | null; ffmpeg?: boolean; platform?: string }): string | null;
export function transcribe(o: {
  file: string;
  bin: string;
  model: string;
  lang?: string;
  onProgress?: (pct: number) => void;
  isFiller?: (text: string) => boolean;
  threads?: number;
}): { done: Promise<{ ok: true; srt: string } | { ok: false; error: string }>; kill: () => void };
export interface SrtPiece {
  start: number;
  end: number;
  text: string;
}
export function parseSrtPieces(srt: string): SrtPiece[];
export function regroupPieces(pieces: SrtPiece[], o?: { isFiller?: (text: string) => boolean }): SrtPiece[];
export function toSrt(lines: SrtPiece[]): string;
