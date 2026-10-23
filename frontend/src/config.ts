// Build-time configuration (Vite env). Only non-secret values belong here;
// the OpenRouter key never reaches the frontend (AGENTS.md 3.6).

const env = import.meta.env;

const trimmed = (v: string | undefined): string => (v ?? '').trim();

export const config = {
  apiBaseUrl: (trimmed(env.VITE_API_BASE_URL) || '/api/v1').replace(/\/+$/, ''),
  useMocks: trimmed(env.VITE_USE_MOCKS).toLowerCase() === 'true',
  mockScenario: trimmed(env.VITE_MOCK_SCENARIO) || 'default',
  studentName: trimmed(env.VITE_STUDENT_NAME),
  studentRoll: trimmed(env.VITE_STUDENT_ROLL),
};
