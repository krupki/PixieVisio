/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_BASE_URL?: string;
  readonly VITE_REALTIME_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
