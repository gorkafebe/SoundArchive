export const BASE_URL = process.env.E2E_BASE_URL ?? "https://soundarchive";
export const ADMIN_STATE = "test-results/.auth/admin.json";
// Only ever used on the throwaway stack that `make e2e` creates and destroys.
export const ADMIN_PASSWORD = "throwaway-e2e-stack-only";
export const USER_PASSWORD = "throwaway-e2e-user-only";
export const MEDIA = "test-results/e2e-media";
