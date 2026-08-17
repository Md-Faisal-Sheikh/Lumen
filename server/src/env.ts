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

  // Which provider answers inline completions. Blank = the same one as builds.
  //
  // Splitting them exists because the two jobs want opposite things. A build is
  // occasional and wants the most capable model available; a completion fires on
  // every pause in typing and wants only to be fast. On a free remote tier that
  // combination is actively harmful: ghost text will spend a daily request
  // allowance in a few minutes of typing and leave nothing for the builds it was
  // meant to assist. A small local model answers completions in milliseconds, for
  // free, forever — while builds keep whatever remote provider is configured.
  COMPLETION_PROVIDER: (process.env.COMPLETION_PROVIDER ?? '') as Provider | '',

  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '',
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL ?? 'nvidia/nemotron-3-ultra-550b-a55b:free',

  // How much a reasoning model is allowed to think before it answers.
  //
  // Every model on OpenRouter's free tier is now a reasoning model, and thinking
  // is charged in both time and tokens before a single character of the app
  // arrives. Lumen's jobs are structured-output jobs — emit these files in this
  // marker format — rather than problems that reward deliberation, so that time
  // largely buys nothing. It is measurable in the worst case: asked to complete
  // one line, the default model above wrote three paragraphs of reasoning and hit
  // its token cap before producing any code.
  //
  // "none" or "minimal" is the speed setting; "low"/"medium"/"high" trade time
  // for deliberation on complex builds. Blank — the default — sends no reasoning
  // field at all, leaving each model's own behaviour untouched.
  OPENROUTER_REASONING: process.env.OPENROUTER_REASONING ?? '',

  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? '',
  // 2.5 rather than the 2.0 this shipped with: 2.0-flash is on its way out, and
  // Flash is fast without being a reasoning model, which is what a build wants.
  GEMINI_MODEL: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',

  OLLAMA_URL: process.env.OLLAMA_URL ?? 'http://localhost:11434',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:7b',

  // Context window for local builds, in tokens. Blank uses Ollama's own default,
  // which at 4096 is smaller than a build needs — the system prompt plus a
  // multi-file app runs past it, and what falls off the end is the end of the
  // app. Around 8192 is the working figure, at a cost in memory: the KV cache
  // grows with this number, so on a machine short of RAM it is the first thing
  // to trade away, and the reason a local *build* needs far more headroom than
  // local completions do.
  OLLAMA_NUM_CTX: process.env.OLLAMA_NUM_CTX ?? '',

  // Context window for completions. Small on purpose, and safely so: the
  // prompt is a fixed window around the caret (PREFIX_BUDGET + SUFFIX_BUDGET,
  // about 3200 characters ≈ 900 tokens) plus 160 tokens of answer, so 2048 is
  // already generous. Every token above that is KV cache nobody reads — which on
  // a small machine is the difference between the model loading and not.
  OLLAMA_COMPLETION_NUM_CTX: process.env.OLLAMA_COMPLETION_NUM_CTX ?? '2048',

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

  // ── Completion: the model behind the editor's ghost text ────────────
  // Separate for the same reason vision is, and the reason is just as concrete.
  // The model that builds an app well is usually the wrong one to finish a line:
  // it is large, it is slow, and increasingly it *reasons out loud* — asked to
  // complete `const sorted = items.` the default build model here answered with
  // three paragraphs about what the user probably wanted, then hit the token cap
  // before ever emitting the code. A completion has about a second to be useful,
  // so it gets a small instruct model of its own and builds keep the good one.
  //
  // Comma-separated fallback list, tried in order, exactly like the vision list —
  // free pools get retired and saturated. Blank turns ghost text off for this
  // provider, and the editor stops asking.
  OPENROUTER_COMPLETION_MODEL:
    process.env.OPENROUTER_COMPLETION_MODEL ??
    'google/gemma-4-26b-a4b-it:free,openai/gpt-oss-20b:free,liquid/lfm-2.5-2.6b:free',
  // Flash-Lite, not the build model — and the daily allowance is the reason as
  // much as the speed. Gemini meters each model separately, so ghost text firing
  // on every pause in typing draws down Lite's (much larger) quota while builds
  // keep Flash's untouched. Blank falls back to reusing GEMINI_MODEL.
  GEMINI_COMPLETION_MODEL: process.env.GEMINI_COMPLETION_MODEL ?? 'gemini-2.5-flash-lite',
  // Already a small, fast coder model — no reason to differ from the build one.
  OLLAMA_COMPLETION_MODEL: process.env.OLLAMA_COMPLETION_MODEL ?? 'qwen2.5-coder:7b',
}

export const isProd = env.NODE_ENV === 'production'
