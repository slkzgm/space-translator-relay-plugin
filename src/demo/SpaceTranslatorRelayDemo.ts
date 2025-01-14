// src/demo/SpaceTranslatorRelayDemo.ts
/**
 * SpaceTranslatorRelay
 * ----------------------
 * Demonstrates hosting a Twitter Space and relaying an external HLS audio
 * through STT -> Translation -> TTS.
 *
 * Steps:
 *  1) Log in via Scraper to get an authenticated session.
 *  2) Obtain the HLS URL from an existing Space or any other method.
 *  3) Create a new Space (host).
 *  4) Use HlsTranslationPlugin to handle chunk-based STT->Translation->TTS.
 *  5) Start the Space, let it run for some time, then stop.
 */

import "dotenv/config";
import { Scraper, Space } from "agent-twitter-client";
import { SpaceTranslatorRelayPlugin } from "../plugins/SpaceTranslatorRelayPlugin";

async function main() {
  // 1) Twitter login
  const scraper = new Scraper();
  await scraper.login(
    process.env.TWITTER_USERNAME!,
    process.env.TWITTER_PASSWORD!,
  );

  // 2) Obtain HLS URL from an existing space or any other method.
  //    Example: scraping a known space by ID (replace '1lDGLlPwAkQGm' with real ID).
  const {
    source: { location: hlsUrl },
  } = await scraper.getAudioSpaceStatus("1lDGLlPwAkQGm");

  // 3) Create a new Space to host
  const relaySpace = new Space(scraper, { debug: false });

  // 4) Attach our plugin
  relaySpace.use(
    new SpaceTranslatorRelayPlugin({
      hlsUrl,
      debug: false,
      sampleRate: 48000,
      channels: 1,
      chunkFlushMs: 5000, // flush every 5 seconds
      sttLanguage: "en",
      targetLanguage: "fr",
      ttsVoiceId: "21m00Tcm4TlvDq8ikWAM", // or any other ElevenLabs voice ID
    }),
  );

  // 5) Initialize => become host => plugin starts HLS reading + STT->TTS
  await relaySpace.initialize({
    mode: "BROADCAST",
    title: "HLS Translate Demo",
    description: "STT->Translation->TTS from HLS source",
  });

  console.log("[HlsTranslateSpaceRelay] Relay space is live!");

  // Let it run for 3 minutes, then stop
  setTimeout(
    async () => {
      console.log("[HlsTranslateSpaceRelay] Stopping...");
      await relaySpace.stop();
      process.exit(0);
    },
    3 * 60 * 1000,
  );
}

main().catch((err) => {
  console.error("[HlsTranslateSpaceRelay] Error =>", err);
  process.exit(1);
});
