# SpaceTranslatorRelayPlugin (Plugin & Demo)

This plugin (and demo script) allows you to **host a new Twitter Space** that receives audio from a **source Twitter Space**, transcribes and translates the audio, and then **retransmits the translated audio** in near real-time. It relies on `agent-twitter-client` for Twitter Spaces interactions, plus STT (OpenAI Whisper), translation (LibreTranslate), and TTS (ElevenLabs) in a chunk-based approach.

---

## Features

- **HLS-based**: Reads the audio source via HLS (`.m3u8`).
- **Chunk-based STT -> Translation -> TTS**:
  - Accumulates raw PCM from HLS,
  - Periodically flushes and converts to WAV for STT,
  - Translates the recognized text,
  - Generates TTS,
  - Streams the TTS into the new hosted Space.
- **Safe TTS queue**: Ensures that multiple TTS outputs do not overlap, avoiding “robotic” or distorted audio.
- **Supports** local or remote **LibreTranslate** server:
  - Local usage: no API key required (run your own LibreTranslate server).
  - Remote usage: supply an API key if the remote server needs one.
- **Environment** and `.env` usage for secrets (OpenAI, ElevenLabs, and optional LibreTranslate keys).

---

## Requirements

1. **Node.js** (version 16+ recommended).
2. **FFmpeg** installed locally (required for audio decoding/encoding).
3. **Python** (3.8+) if you plan to **run LibreTranslate** locally.
4. **Git** to clone the repository.

---

## Installation & Setup

1. **Clone** the repository:
   ```bash
   git clone https://github.com/slkzgm/space-translator-relay-plugin.git
   cd space-translator-relay-plugin 
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```
   or if you prefer yarn:
   ```bash
   yarn
   ```

3. **Install `agent-twitter-client`**:
    - Currently, the plugin may rely on a **GitHub version** of `agent-twitter-client` if the official NPM package is not up to date.
    - You might do something like:
      ```bash
      npm install git+https://github.com/yourusername/agent-twitter-client.git
      ```
    - Or if the official release is available:
      ```bash
      npm install agent-twitter-client
      ```

4. **Set up `.env`**:
    - Create a `.env` file at the root (same level as your `package.json`) with:
      ```dotenv
      TWITTER_USERNAME=YourTwitterUsername
      TWITTER_PASSWORD=YourPassword
      OPENAI_API_KEY=sk-...
      ELEVENLABS_API_KEY=...
      # If you want a remote LibreTranslate server:
      LIBRETRANSLATE_API_KEY=...
      # If desired, override the default local endpoint:
      # LIBRETRANSLATE_URL=https://libretranslate.example.com/translate
      ```
    - If you run LibreTranslate **locally**, you may skip the `LIBRETRANSLATE_API_KEY`.
    - If using a remote server, **ensure** you provide that key.

---

## Running LibreTranslate Locally

We leverage [LibreTranslate](https://github.com/LibreTranslate/LibreTranslate) for translation. You can run your own server locally:

1. **Install** Python 3.8+.
2. **Install** the package:
   ```bash
   pip install libretranslate
   ```
3. **Run** the server:
   ```bash
   libretranslate --load-only en,fr
   ```
   This example loads only English (`en`) and French (`fr`) to reduce startup time.

LibreTranslate will start on [http://localhost:5000](http://localhost:5000). No API key is needed in local mode.

(For more details or alternative approaches like using Ubuntu scripts, see the [LibreTranslate GitHub repo](https://github.com/LibreTranslate/LibreTranslate).)

---

## Usage

### Hosting a new Space with Translated Audio

1. **Build**/Compile if needed (TypeScript):
   ```bash
   npx tsc
   ```
2. **Run** the demo script (in `src/demo`) with a space URL argument:
   ```bash
   ts-node src/demo/SpaceTranslatorRelayDemo.ts "https://x.com/i/spaces/1YpJklzMDbZxj"
   ```
    - The script will:
        1. Log in to Twitter with your `.env` credentials.
        2. Scrape the source Space ID from the provided URL (e.g. `1YpJklzMDbZxj`).
        3. Fetch the HLS `.m3u8` URL for that Space.
        4. Create a new hosted Space.
        5. Use the `SpaceTranslatorRelayPlugin` to read from the source HLS, do STT->Translate->TTS, and push into the new Space.

3. **Check logs** for progress and potential warnings (e.g., if no API key is found for a remote LibreTranslate server).

4. **Stop**:
    - The script auto-stops after ~3 minutes in the example.
    - Or press `Ctrl + C`.

---

## Contributing

- If the `agent-twitter-client` package is not yet published with the needed changes, you can temporarily install the Git-based version.
- PRs to improve chunking, reduce latency, or support other TTS providers are welcome.

---

**Enjoy the minimal chunk-based STT->Translation->TTS pipeline for Twitter Spaces!**