/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_USE_MOCKS?: string;
  readonly VITE_MOCK_SCENARIO?: string;
  readonly VITE_STUDENT_NAME?: string;
  readonly VITE_STUDENT_ROLL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
