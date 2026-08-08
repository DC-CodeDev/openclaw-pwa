/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly GATEWAY_URL: string
  readonly GATEWAY_TOKEN: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
