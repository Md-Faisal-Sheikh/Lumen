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
}

export const isProd = env.NODE_ENV === 'production'
