// Runs once before the tests: signs in the test administrator, saves that
// browser state for the tests, and adds example places if there are none.
import { mkdirSync } from "node:fs";

import { request } from "@playwright/test";

import { ADMIN_PASSWORD, ADMIN_STATE, BASE_URL } from "./constants";

const AREAS: [number, number, number, number][] = [
  [-2.935, 43.263, 0.05, 40],
  [-3.703, 40.417, 0.08, 40],
  [2.17, 41.387, 0.06, 30],
];
const KINDS = ["Fountain", "Market", "Harbour", "Forest path", "Station", "Square", "Beach", "Bridge"];

export default async function globalSetup() {
  mkdirSync("test-results/.auth", { recursive: true });
  const api = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Origin: BASE_URL } });
  const login = await api.post("/api/auth/login", { data: { username: "e2e-admin", password: ADMIN_PASSWORD } });
  if (!login.ok()) throw new Error(`Could not sign in the test administrator: ${login.status()}`);
  const { csrf_token: csrf } = await login.json();
  await api.storageState({ path: ADMIN_STATE });

  const list = await (await api.get("/api/places/list?limit=1")).json();
  if (list.total < 100) {
    let n = 0;
    let seed = 20261108;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (const [lon, lat, spread, count] of AREAS) {
      for (let i = 0; i < count; i++) {
        n += 1;
        const response = await api.post("/api/places", {
          headers: { "X-CSRF-Token": csrf },
          data: {
            name: `${KINDS[n % KINDS.length]} ${n}`,
            description: "Example data for the end-to-end tests.",
            latitude: lat + (next() - 0.5) * spread,
            longitude: lon + (next() - 0.5) * spread,
          },
        });
        if (!response.ok()) throw new Error(`Could not add a place: ${response.status()}`);
      }
    }
  }
  await api.dispose();
}
