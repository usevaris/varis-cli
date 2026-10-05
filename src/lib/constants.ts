/**
 * Environment variables, as a plain map. A type only: it disappears when the
 * CLI is compiled, and the binary needs no Node.js on the user's machine.
 */
export type Env = Record<string, string | undefined>;

/**
 * The Varis API. The only place the hostname appears in the CLI.
 *
 * Paths are appended as `/v1/...`. In production that is api.usevaris.com/v1/...
 */
export const VARIS_API_ORIGIN = "https://api.usevaris.com";

/**
 * The API origin this run talks to. `VARIS_API_URL` overrides it, for local
 * development against a running `varis` app, whose routes live under /api:
 *
 *   VARIS_API_URL=http://localhost:3000/api varis login
 *
 * A trailing slash is dropped, so `${apiOrigin()}/v1/...` is always one slash.
 */
export function apiOrigin(env: Env = process.env): string {
  const override = env.VARIS_API_URL?.trim();
  return (override || VARIS_API_ORIGIN).replace(/\/+$/, "");
}

/**
 * Where bugs are reported: the public varis-cli repository. Only here, so a
 * move to a Varis organisation on GitHub is a one-line change.
 */
export const REPOSITORY_URL = "https://github.com/usevaris/varis-cli";

export const ISSUES_URL = `${REPOSITORY_URL}/issues`;

/** How to write a report we can act on. */
export const REPORTING_GUIDE_URL =
  `${REPOSITORY_URL}/blob/main/docs/reporting-issues.md`;

/**
 * Where the SDKs and their generators live. A generator crash in varis build
 * is reported there, not here.
 */
export const SDK_REPOSITORY_URL = "https://github.com/usevaris/varis-ts";

export const SDK_ISSUES_URL = `${SDK_REPOSITORY_URL}/issues`;

/** Varis documentation. Pages linked from the CLI are stubs until written. */
export const DOCS_URL = "https://usevaris.com/docs";

/** How a service's path, endpoint_url, base_url, and test_base_url relate. */
export const ENDPOINTS_DOCS_URL = `${DOCS_URL}/services/endpoints`;
