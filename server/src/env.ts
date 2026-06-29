import 'dotenv/config'

type Provider = 'groq' | 'gemini' | 'ollama'

export const env = {
  PORT: Number(process.env.PORT ?? 4000),
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  JWT_SECRET: process.env.JWT_SECRET ?? 'dev-insecure-secret-change-me',
  CLIENT_ORIGIN: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',

  AI_PROVIDER: (process.env.AI_PROVIDER ?? 'groq') as Provider,

  GROQ_API_KEY: process.env.GROQ_API_KEY ?? '',
  GROQ_MODEL: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',

  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? '',
  GEMINI_MODEL: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',

  OLLAMA_URL: process.env.OLLAMA_URL ?? 'http://localhost:11434',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:7b',
}

export const isProd = env.NODE_ENV === 'production'
