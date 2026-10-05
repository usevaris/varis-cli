import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiError, ApiRequestFn, ApiResult, RequestOptions } from "../src/lib/api.ts";
import { type LoginDeps, runLogin } from "../src/commands/login.ts";
import { VARIS_API_ORIGIN } from "../src/lib/constants.ts";
import {
  type CredentialsLocation,
  readToken,
  saveToken,
} from "../src/lib/credentials.ts";
import type { Output } from "../src/lib/output.ts";

const NEW_TOKEN = `var_dt_${"n".repeat(40)}`;
const OLD_TOKEN = `var_dt_${"o".repeat(40)}`;

const CODE = {
  device_code: "var_dc_x",
  user_code: "WDJB-MJHT",
  verification_uri: "https://usevaris.com/authorisation/device",
  verification_uri_complete: "https://usevaris.com/authorisation/device?code=WDJB-MJHT",
  expires_in: 600,
  interval: 5,
};

type Call = { method: string; path: string; options: RequestOptions };

let home: string;
let credentials: CredentialsLocation;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "varis-cli-login-"));
  credentials = { env: {}, platform: process.platform, home };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const pollError = (code: string, extra: Record<string, unknown> = {}): ApiResult<never> => ({
  ok: false,
  error: {
    kind: "request",
    status: 400,
    code,
    message: code,
    body: { error: code, ...extra },
  } as ApiError,
});

/**
 * A scripted server. `polls` answers /v1/cli/device/token in turn; the last
 * answer repeats. Everything else answers from fixed responses.
 */
function setup(polls: ApiResult<unknown>[], overrides: Partial<LoginDeps> = {}) {
  const calls: Call[] = [];
  const slept: number[] = [];
  let clock = 0;
  let poll = 0;

  const request = (async (method, path, options) => {
    calls.push({ method, path, options });
    if (path === "/v1/cli/device/code") return { ok: true, status: 200, body: CODE };
    if (path === "/v1/cli/device/token") {
      return polls[Math.min(poll++, polls.length - 1)];
    }
    if (path === "/v1/me/owners") {
      return { ok: true, status: 200, body: { owners: [{ id: "o", name: "World Bank", role: "admin" }] } };
    }
    if (path === "/v1/cli/logout") return { ok: true, status: 200, body: { signed_out: true } };
    throw new Error(`unexpected ${path}`);
  }) as ApiRequestFn;

  const opened: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const statuses: string[] = [];
  const output: Output = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    status: (t) => statuses.push(t),
    styled: overrides.env?.FORCE_COLOR === "1",
  };

  const deps: LoginDeps = {
    env: {},
    credentials,
    request,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => clock,
    canOpenBrowser: () => true,
    openBrowser: (url) => opened.push(url),
    ...overrides,
  };

  return { deps, calls, slept, opened, out, err, statuses, output };
}

const approved: ApiResult<unknown> = {
  ok: true,
  status: 200,
  body: { access_token: NEW_TOKEN, token_type: "Bearer", expires_in: 15552000 },
};

describe("varis login", () => {
  it("prints the link and code, polls until approved, and saves the token", async () => {
    const t = setup([pollError("authorization_pending"), pollError("authorization_pending"), approved]);

    expect(await runLogin([], t.output, t.deps)).toBe(0);

    const printed = t.err.join("\n");
    expect(printed).toContain("Open this link to approve signing in:");
    expect(printed).toContain(CODE.verification_uri_complete);
    expect(printed).toContain("Check the page shows this code: WDJB-MJHT");
    expect(printed).not.toContain("another device");
    expect(t.opened).toEqual([CODE.verification_uri_complete]);
    expect(t.slept).toEqual([5000, 5000, 5000]);
    expect(await readToken(VARIS_API_ORIGIN, credentials)).toEqual({
      status: "signed_in",
      token: NEW_TOKEN,
    });
    expect(t.out).toEqual([
      "✓ Signed in. This machine can now publish services.",
      "",
      "You can publish for:",
      "  World Bank (o)",
    ]);
  });

  it("reports each check, and each pending answer", async () => {
    const t = setup([pollError("authorization_pending"), approved]);
    await runLogin([], t.output, t.deps);
    expect(t.statuses).toEqual([
      "Checking for approval…",
      "Approval still pending. Approve in the browser. If you have, please wait. Checking again…",
      "Checking for approval…",
    ]);
  });

  it("prints the success line in green on a terminal, and plain elsewhere", async () => {
    const plain = setup([approved]);
    await runLogin([], plain.output, plain.deps);
    expect(plain.out[0]).toBe("✓ Signed in. This machine can now publish services.");

    const coloured = setup([approved], { env: { FORCE_COLOR: "1" } });
    await runLogin([], coloured.output, coloured.deps);
    expect(coloured.out[0]).toBe(
      "\x1b[32m✓ Signed in. This machine can now publish services.\x1b[0m",
    );
  });

  it("sends the machine's name, and no credential, to start", async () => {
    const t = setup([approved], { env: { CODESPACE_NAME: "ada-shiny-train" } });
    await runLogin([], t.output, t.deps);

    const start = t.calls[0]!;
    expect(start.path).toBe("/v1/cli/device/code");
    expect(start.options.auth).toBe("none");
    expect(start.options.body).toEqual({ device_name: "GitHub Codespaces: ada-shiny-train" });
  });

  it("slows down when asked, using the server's interval", async () => {
    const t = setup([pollError("slow_down", { interval: 10 }), approved]);
    await runLogin([], t.output, t.deps);
    expect(t.slept).toEqual([5000, 10000]);
  });

  it("adds five seconds on slow_down when the server gives no interval", async () => {
    const t = setup([pollError("slow_down"), approved]);
    await runLogin([], t.output, t.deps);
    expect(t.slept).toEqual([5000, 10000]);
  });

  it("stops on denial, saving nothing", async () => {
    const t = setup([pollError("access_denied")]);
    expect(await runLogin([], t.output, t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("The sign-in was denied");
    expect(await readToken(VARIS_API_ORIGIN, credentials)).toEqual({ status: "signed_out" });
  });

  it("stops when the server says the code expired", async () => {
    const t = setup([pollError("expired_token")]);
    expect(await runLogin([], t.output, t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("The code expired. Run varis login again.");
  });

  it("gives up at the code's own expiry, even if the server never says so", async () => {
    const t = setup([pollError("authorization_pending")]);
    expect(await runLogin([], t.output, t.deps)).toBe(1);
    // 600 seconds at 5-second intervals.
    expect(t.slept).toHaveLength(120);
    expect(t.err.at(-1)).toContain("expired");
  });

  it("keeps polling through a network blip, saying so once", async () => {
    const blip: ApiResult<never> = {
      ok: false,
      error: { kind: "network", message: "Couldn't reach Varis." },
    };
    const t = setup([blip, blip, approved]);

    expect(await runLogin([], t.output, t.deps)).toBe(0);
    expect(t.err.filter((line) => line.includes("still trying"))).toHaveLength(1);
  });

  it("doesn't open a browser with --no-browser, or where none can appear", async () => {
    const flag = setup([approved]);
    await runLogin(["--no-browser"], flag.output, flag.deps);
    expect(flag.opened).toEqual([]);

    const ssh = setup([approved], { canOpenBrowser: () => false });
    await runLogin([], ssh.output, ssh.deps);
    expect(ssh.opened).toEqual([]);
    expect(ssh.err.join("\n")).toContain(CODE.verification_uri_complete);
  });

  it("replaces an earlier token and revokes it on the server", async () => {
    await saveToken(VARIS_API_ORIGIN, OLD_TOKEN, credentials);
    const t = setup([approved]);

    expect(await runLogin([], t.output, t.deps)).toBe(0);

    expect(await readToken(VARIS_API_ORIGIN, credentials)).toMatchObject({ token: NEW_TOKEN });
    const logout = t.calls.find((c) => c.path === "/v1/cli/logout");
    expect(logout?.options).toMatchObject({ auth: "none", bearer: OLD_TOKEN });
  });

  it("reports a failure to start, without polling", async () => {
    const t = setup([approved], {
      request: (async () => ({
        ok: false,
        error: { kind: "network", message: "Couldn't reach Varis at https://api.usevaris.com." },
      })) as ApiRequestFn,
    });
    expect(await runLogin([], t.output, t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("Couldn't start signing in");
    expect(t.slept).toEqual([]);
  });

  it("rejects an unknown option", async () => {
    const t = setup([approved]);
    expect(await runLogin(["--nope"], t.output, t.deps)).toBe(2);
  });
});
