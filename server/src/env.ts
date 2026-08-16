import 'dotenv/config'

type Provider = 'openrouter' | 'gemini' | 'ollama'

export const env = {
  PORT: Number(process.env.PORT ?? 4000),
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  JWT_SECRET: process.env.JWT_SECRET ?? 'dev-insecure-secret-change-me',
  CLIENT_ORIGIN: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  // Origin the public /p/<slug> links are built from. Behind a proxy the request
  // host is the internal one, so set this in production; empty = use the request.
  PUBLIC_URL: process.env.PUBLIC_URL ?? '',

  AI_PROVIDER: (process.env.AI_PROVIDER ?? 'openrouter') as Provider,

  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '',
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL ?? 'nvidia/nemotron-3-ultra-550b-a55b:free',

  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? '',
  GEMINI_MODEL: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',

  OLLAMA_URL: process.env.OLLAMA_URL ?? 'http://localhost:11434',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:7b',

  // ── Vision: the model used only when a sketch or screenshot is attached ──
  // A provider's best *coding* model usually can't see, so images get their own
  // model and text builds keep running on the ones above. Set any of these to
  // an empty string to turn image builds off for that provider.
  //
  // OpenRouter's is a comma-separated fallback list, because its free pool is
  // shared: a model can be retired outright (404) or busy (429), and either is
  // survivable if there's a next one to try. Pin it to a single name if you'd
  // rather know when your choice is unavailable than get a quiet substitute.
  OPENROUTER_VISION_MODEL:
    process.env.OPENROUTER_VISION_MODEL ??
    'google/gemma-4-31b-it:free,nvidia/nemotron-nano-12b-v2-vl:free,google/gemma-4-26b-a4b-it:free',
  // Gemini's default is already multimodal, so it doubles as its own vision model.
  GEMINI_VISION_MODEL: process.env.GEMINI_VISION_MODEL ?? '',
  OLLAMA_VISION_MODEL: process.env.OLLAMA_VISION_MODEL ?? 'qwen2.5vl:7b',
}

export const isProd = env.NODE_ENV === 'production'
