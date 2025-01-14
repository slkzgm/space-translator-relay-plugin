// src/plugins/SpaceTranslatorRelayPlugin.ts
/**
 * SpaceTranslatorRelayPlugin
 * --------------------
 * Reads an HLS (m3u8) stream with FFmpeg, accumulates raw PCM,
 * performs STT -> translation -> TTS in chunks, and pushes the
 * resulting audio into a hosted Twitter Space via Janus.
 *
 * Key features:
 *  - Periodic flush of PCM => WAV => STT => translation => TTS
 *  - A TTS queue to avoid overlapping outputs (which can cause distortion)
 *  - Copies each 10ms (480 samples at 48kHz mono) in a fresh Int16Array
 *    to prevent partial memory overlap issues
 *  - Chunk-based approach with a small real-time delay
 *
 * Additional note for LibreTranslate:
 *  - If you provide a non-localhost URL (e.g. https://libretranslate.com/translate),
 *    you can optionally supply an API key via either environment variable
 *    or plugin config. If no API key is found and you're using a remote server,
 *    we'll log a warning. Then we'll add `api_key` into the request body.
 */

import { Plugin } from "agent-twitter-client/dist/types";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { JanusClient, Logger } from "agent-twitter-client";
import * as fs from "fs";
import * as path from "path";

// Environment variables and default endpoint
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const LIBRETRANSLATE_URL_DEFAULT =
  process.env.LIBRETRANSLATE_URL || "http://localhost:5000/translate";
const LIBRETRANSLATE_API_KEY_ENV = process.env.LIBRETRANSLATE_API_KEY || "";

/**
 * Transcribes a WAV file using OpenAI Whisper's API.
 */
async function openAiStt(wavFile: string, language = "en"): Promise<string> {
  if (!OPENAI_KEY) {
    console.warn("[openAiStt] Missing OPENAI_API_KEY; returning empty.");
    return "";
  }

  const fileBuffer = fs.readFileSync(wavFile);
  const blob = new Blob([fileBuffer], { type: "audio/wav" });
  const formData = new FormData();

  formData.append("file", blob, path.basename(wavFile));
  formData.append("model", "whisper-1");
  formData.append("language", language);

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: formData,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[openAiStt] Error =>", errText);
    return "";
  }

  const data = (await resp.json()) as { text: string };
  return data.text.trim();
}

/**
 * Translates text to target language using LibreTranslate or similar.
 * If an API key is set (in config or env), we include it in the JSON body.
 */
async function libreTranslate(
  text: string,
  targetLang: string,
  translateUrl: string,
  translateApiKey?: string,
): Promise<string> {
  if (!text) return "";
  const body: Record<string, string> = {
    q: text,
    source: "auto",
    target: targetLang,
    format: "text",
  };

  // If the user-supplied URL is not localhost and there's a key, or if user specifically wants it
  // then we attach api_key to the request
  const isLocalhost = translateUrl.includes("localhost");
  const effectiveApiKey = translateApiKey || LIBRETRANSLATE_API_KEY_ENV;

  if (!isLocalhost && !effectiveApiKey) {
    console.warn(
      "[libreTranslate] WARNING: Using a non-localhost endpoint but no API key found.",
    );
  }
  if (effectiveApiKey) {
    body.api_key = effectiveApiKey;
  }

  const resp = await fetch(translateUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[libreTranslate] Error =>", errText);
    return text; // fallback
  }

  const result = (await resp.json()) as { translatedText: string };
  return result.translatedText;
}

/**
 * Generates TTS audio with ElevenLabs, returns raw PCM (s16le).
 */
async function elevenLabsTts(
  text: string,
  voiceId = "21m00Tcm4TlvDq8ikWAM",
): Promise<Int16Array> {
  if (!ELEVENLABS_KEY) {
    console.warn(
      "[elevenLabsTts] Missing ELEVENLABS_API_KEY; returning beep fallback.",
    );
    return syntheticBeepPcm();
  }
  console.log("[elevenLabsTts] Request =>", text);

  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": ELEVENLABS_KEY,
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_monolingual_v1",
        voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      }),
    },
  );

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[elevenLabsTts] Error =>", errText);
    return syntheticBeepPcm();
  }

  const mp3Buffer = Buffer.from(await resp.arrayBuffer());
  return convertMp3ToPcm(mp3Buffer, 48000);
}

/**
 * Fallback TTS: produce a ~0.5s beep if TTS fails or no key is available.
 */
function syntheticBeepPcm(): Int16Array {
  const sampleRate = 48000;
  const durationMs = 500;
  const totalSamples = Math.floor((sampleRate * durationMs) / 1000);
  const beep = new Int16Array(totalSamples);

  const freq = 440;
  const amplitude = 8000;
  for (let i = 0; i < beep.length; i++) {
    const t = i / sampleRate;
    beep[i] = amplitude * Math.sin(2 * Math.PI * freq * t);
  }
  return beep;
}

/**
 * Converts MP3 data to raw PCM (s16le) using ffmpeg.
 */
async function convertMp3ToPcm(
  mp3Buffer: Buffer,
  outRate: number,
  outChannels = 1,
): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-i",
      "pipe:0",
      "-f",
      "s16le",
      "-ar",
      outRate.toString(),
      "-ac",
      outChannels.toString(),
      "pipe:1",
    ]);

    let rawData = Buffer.alloc(0);
    ff.stdout.on("data", (chunk) => {
      rawData = Buffer.concat([rawData, chunk]);
    });
    ff.stderr.on("data", () => {
      /* ignoring logs */
    });

    ff.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg mp3->pcm returned code=${code}`));
      }
      // Convert rawData -> Int16
      const arr = new Int16Array(rawData.length / 2);
      for (let i = 0; i < arr.length; i++) {
        arr[i] = rawData.readInt16LE(i * 2);
      }
      resolve(arr);
    });

    ff.on("error", reject);
    ff.stdin.write(mp3Buffer);
    ff.stdin.end();
  });
}

/**
 * Configuration for SpaceTranslatorRelayPlugin.
 */
interface SpaceTranslatorRelayConfig {
  hlsUrl: string;
  debug?: boolean;
  sampleRate?: number;
  channels?: number;
  chunkFlushMs?: number;
  sttLanguage?: string;
  targetLanguage?: string;
  ttsVoiceId?: string;

  /**
   * If you want to override the default LibreTranslate URL from .env,
   * specify it here. Otherwise defaults to LIBRETRANSLATE_URL_DEFAULT.
   */
  translateUrl?: string;

  /**
   * If you want to supply an explicit API key for LibreTranslate
   * (when not running locally, for example).
   */
  translateApiKey?: string;
}

/**
 * HlsTranslationPlugin
 * --------------------
 * 1) Periodically flush PCM from an HLS feed => STT => translation => TTS.
 * 2) Uses a TTS queue so outputs do not overlap.
 * 3) Copies each 10ms chunk (480 samples at 48kHz mono) to avoid partial references.
 */
export class SpaceTranslatorRelayPlugin implements Plugin {
  private logger: Logger;
  private janus?: JanusClient;

  private hlsUrl: string;
  private sampleRate: number;
  private channels: number;
  private chunkFlushMs: number;
  private sttLanguage: string;
  private targetLanguage: string;
  private ttsVoiceId: string;

  // Additional config for translation
  private translateUrl: string;
  private translateApiKey?: string;

  private ffmpegProcess?: ChildProcessWithoutNullStreams;
  private isStreaming = false;
  private pcmBuffer = Buffer.alloc(0);
  private flushTimer?: NodeJS.Timeout;

  // TTS concurrency queue
  private ttsQueue: Int16Array[] = [];
  private ttsProcessing = false;

  constructor(config: SpaceTranslatorRelayConfig) {
    this.hlsUrl = config.hlsUrl;
    this.sampleRate = config.sampleRate ?? 48000;
    this.channels = config.channels ?? 1;
    this.logger = new Logger(!!config.debug);
    this.chunkFlushMs = config.chunkFlushMs ?? 4000;
    this.sttLanguage = config.sttLanguage ?? "en";
    this.targetLanguage = config.targetLanguage ?? "en";
    this.ttsVoiceId = config.ttsVoiceId ?? "21m00Tcm4TlvDq8ikWAM";

    // Handle translation config
    this.translateUrl = config.translateUrl || LIBRETRANSLATE_URL_DEFAULT;
    this.translateApiKey = config.translateApiKey;
  }

  onAttach() {
    this.logger.info("[HlsTranslationPlugin] attached");
  }

  init() {
    this.logger.info(
      "[HlsTranslationPlugin] init => ready to spawn ffmpeg soon",
    );
  }

  onJanusReady(janus: JanusClient) {
    this.janus = janus;
    this.logger.info("[HlsTranslationPlugin] onJanusReady => Janus is set");
    this.startHlsReading();

    // Periodically flush the accumulated PCM => STT->Translation->TTS
    this.flushTimer = setInterval(() => {
      this.flushChunkForTranslation();
    }, this.chunkFlushMs);
  }

  private startHlsReading() {
    if (this.isStreaming) return;
    if (!this.janus) {
      this.logger.error(
        "[HlsTranslationPlugin] No Janus client; cannot start HLS",
      );
      return;
    }
    this.isStreaming = true;

    this.logger.info(
      `[HlsTranslationPlugin] Spawning ffmpeg with HLS=${this.hlsUrl}`,
    );
    const args = [
      "-i",
      this.hlsUrl,
      "-f",
      "s16le",
      "-ar",
      this.sampleRate.toString(),
      "-ac",
      this.channels.toString(),
      "pipe:1",
    ];
    this.ffmpegProcess = spawn("ffmpeg", args);

    if (!this.ffmpegProcess) {
      this.logger.error("[HlsTranslationPlugin] Failed to spawn ffmpeg");
      return;
    }

    this.ffmpegProcess.stdout.on("data", (chunk: Buffer) => {
      this.pcmBuffer = Buffer.concat([this.pcmBuffer, chunk]);
    });

    this.ffmpegProcess.stderr.on("data", (errData: Buffer) => {
      if (this.logger.isDebugEnabled()) {
        this.logger.debug(
          "[HlsTranslationPlugin:ffmpeg:err]",
          errData.toString(),
        );
      }
    });

    this.ffmpegProcess.on("close", (code) => {
      this.logger.info("[HlsTranslationPlugin] ffmpeg exited, code=", code);
      this.isStreaming = false;
    });

    this.ffmpegProcess.on("error", (err) => {
      this.logger.error("[HlsTranslationPlugin] ffmpeg error =>", err);
      this.isStreaming = false;
    });
  }

  /**
   * flushChunkForTranslation:
   *  1) Copy and reset pcmBuffer
   *  2) Convert to WAV (with ffmpeg)
   *  3) STT (OpenAI Whisper)
   *  4) Translate (LibreTranslate)
   *  5) TTS (ElevenLabs)
   *  6) Push to TTS queue => processTtsQueue()
   */
  private async flushChunkForTranslation() {
    if (this.pcmBuffer.length === 0) {
      this.logger.debug("[HlsTranslationPlugin] flush => buffer empty");
      return;
    }

    const chunkBuf = this.pcmBuffer;
    this.pcmBuffer = Buffer.alloc(0);

    try {
      const wavPath = await this.convertPcmToWav(chunkBuf);
      this.logger.info(
        `[HlsTranslationPlugin] flush => created WAV at ${wavPath}`,
      );

      const recognizedText = await openAiStt(wavPath, this.sttLanguage);
      const translatedText = await libreTranslate(
        recognizedText,
        this.targetLanguage,
        this.translateUrl,
        this.translateApiKey,
      );
      const ttsPcm = await elevenLabsTts(translatedText, this.ttsVoiceId);

      fs.unlinkSync(wavPath);

      this.ttsQueue.push(ttsPcm);
      this.processTtsQueue().catch((err) => {
        this.logger.error(
          "[HlsTranslationPlugin] processTtsQueue => error",
          err,
        );
      });
    } catch (err) {
      this.logger.error(
        "[HlsTranslationPlugin] flushChunkForTranslation =>",
        err,
      );
    }
  }

  /**
   * convertPcmToWav: writes a temporary WAV file from raw PCM using ffmpeg.
   */
  private convertPcmToWav(chunkBuf: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const tmpPath = path.resolve("/tmp", `hls_chunk_${Date.now()}.wav`);
      const ff = spawn("ffmpeg", [
        "-f",
        "s16le",
        "-ar",
        this.sampleRate.toString(),
        "-ac",
        this.channels.toString(),
        "-i",
        "pipe:0",
        "-y",
        tmpPath,
      ]);

      ff.stdin.write(chunkBuf);
      ff.stdin.end();

      ff.on("close", (code) => {
        if (code === 0) resolve(tmpPath);
        else reject(new Error(`ffmpeg pcm->wav code=${code}`));
      });
      ff.on("error", reject);
    });
  }

  /**
   * processTtsQueue: sequentially streams each TTS result to Janus
   * to avoid overlapping multiple TTS outputs in the same channel.
   */
  private async processTtsQueue() {
    if (this.ttsProcessing) return;
    this.ttsProcessing = true;

    while (this.ttsQueue.length > 0) {
      const nextPcm = this.ttsQueue.shift();
      if (!nextPcm) continue;
      await this.sendTtsPcmToJanus(nextPcm);
    }

    this.ttsProcessing = false;
  }

  /**
   * sendTtsPcmToJanus: breaks TTS PCM into 10ms frames (480 samples at 48kHz mono)
   * and pushes them with a short delay to replicate real-time streaming.
   */
  private async sendTtsPcmToJanus(rawPcm: Int16Array) {
    if (!this.janus) {
      this.logger.warn(
        "[HlsTranslationPlugin] sendTtsPcmToJanus => no Janus client",
      );
      return;
    }
    const frameSizeSamples = Math.floor(this.sampleRate * 0.01) * this.channels;
    let offset = 0;

    // Send full frames
    while (offset + frameSizeSamples <= rawPcm.length) {
      const frame = new Int16Array(frameSizeSamples);
      for (let i = 0; i < frameSizeSamples; i++) {
        frame[i] = rawPcm[offset + i];
      }
      offset += frameSizeSamples;

      this.janus.pushLocalAudio(frame, this.sampleRate, this.channels);
      await new Promise((r) => setTimeout(r, 10));
    }

    // Leftover => pad with zeros if needed
    const leftover = rawPcm.length - offset;
    if (leftover > 0 && leftover < frameSizeSamples) {
      const padFrame = new Int16Array(frameSizeSamples);
      for (let i = 0; i < leftover; i++) {
        padFrame[i] = rawPcm[offset + i];
      }
      this.janus.pushLocalAudio(padFrame, this.sampleRate, this.channels);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  cleanup() {
    this.logger.info("[HlsTranslationPlugin] cleanup => stopping ffmpeg/timer");
    if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
      this.ffmpegProcess.kill();
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.isStreaming = false;
    this.pcmBuffer = Buffer.alloc(0);
    this.ttsQueue = [];
    this.ttsProcessing = false;
  }
}
