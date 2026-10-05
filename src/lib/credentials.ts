// The credentials file: where `varis login` keeps this machine's device token.
//
//   macOS, Linux  ~/.config/varis/credentials.toml, or $XDG_CONFIG_HOME/varis
//   Windows       %APPDATA%\varis\credentials.toml
//
// One token per machine. It identifies the developer, not a project or an
// owner, so it covers every project and every owner they belong to. Signing
// in again replaces it.
//
//   token = "var_dt_..."
//   api = "https://api.usevaris.com"
//
// `api` records the Varis server that issued the token. If the CLI is
// pointed somewhere else, which only happens when working on Varis itself
// against a local app, the token reads as belonging elsewhere and is never
// sent to the wrong server.
//
// The shape is fixed, so a small strict parser reads it rather than a TOML
// library. Anything that doesn't match reads as corrupt, never as a crash.
//
// The file signs in as its owner, so only they may read it: the file is 0600
// and its folder 0700. An existing file readable by anyone else is tightened
// on read. Windows keeps %APPDATA% per user, and ignores these modes.

import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Env } from "./constants.ts";

/** Where to look, injectable so tests never touch the real home directory. */
export type CredentialsLocation = {
  env: Env;
  platform: typeof process.platform;
  home: string;
};

export const defaultLocation = (): CredentialsLocation => ({
  env: process.env,
  platform: process.platform,
  home: os.homedir(),
});

/** What the credentials file holds. */
export type Credentials = { token: string; api: string };

export type CredentialsResult =
  | { status: "signed_in"; credentials: Credentials }
  | { status: "signed_out" }
  | { status: "corrupt"; path: string; reason: string };

export type ReadResult =
  | { status: "signed_in"; token: string }
  /** Signed in, but to `api`, not the server this run talks to. */
  | { status: "signed_in_elsewhere"; api: string }
  | { status: "signed_out" }
  | { status: "corrupt"; path: string; reason: string };

/** A device token, as issued by POST /v1/cli/device/token. */
const TOKEN_PATTERN = /^var_dt_[0-9A-Za-z]{40}$/;

const HEADER = `# Written by varis login. This file signs in as you: keep it private.
# Run varis logout to sign this machine out.
`;

export function credentialsPath(
  location: CredentialsLocation = defaultLocation(),
): string {
  const { env, platform, home } = location;

  if (platform === "win32") {
    const appData = env.APPDATA?.trim() ||
      path.win32.join(home, "AppData", "Roaming");
    return path.win32.join(appData, "varis", "credentials.toml");
  }

  // XDG_CONFIG_HOME must be absolute to count, per the XDG spec.
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const configHome = xdg && path.isAbsolute(xdg)
    ? xdg
    : path.join(home, ".config");
  return path.join(configHome, "varis", "credentials.toml");
}

/** The whole file: the token and the server that issued it. */
export async function readCredentials(
  location: CredentialsLocation = defaultLocation(),
): Promise<CredentialsResult> {
  const file = credentialsPath(location);

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { status: "signed_out" };
    throw error;
  }

  if (location.platform !== "win32") await tightenIfExposed(file);

  const parsed = parseCredentials(text);
  return parsed.ok
    ? { status: "signed_in", credentials: parsed.credentials }
    : { status: "corrupt", path: file, reason: parsed.reason };
}

/** The token to send to `origin`, or why there isn't one. */
export async function readToken(
  origin: string,
  location: CredentialsLocation = defaultLocation(),
): Promise<ReadResult> {
  const result = await readCredentials(location);
  if (result.status !== "signed_in") return result;

  const { token, api } = result.credentials;
  return api === origin
    ? { status: "signed_in", token }
    : { status: "signed_in_elsewhere", api };
}

/**
 * Stores `token`, issued by `origin`, replacing whatever the file held: an
 * earlier token, one from another server, or corrupt contents.
 */
export async function saveToken(
  origin: string,
  token: string,
  location: CredentialsLocation = defaultLocation(),
): Promise<void> {
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error("Refusing to save something that isn't a device token.");
  }
  await writeCredentials({ token, api: origin }, location);
}

/** Deletes the file. Returns false when there was none. */
export async function deleteToken(
  location: CredentialsLocation = defaultLocation(),
): Promise<boolean> {
  try {
    await rm(credentialsPath(location));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/**
 * Writes to a temporary file in the same folder and renames it into place,
 * so a crash mid-write never leaves a half-written file. The mode is set on
 * creation, so the token is never readable by others, even briefly.
 */
async function writeCredentials(
  credentials: Credentials,
  location: CredentialsLocation,
): Promise<void> {
  const file = credentialsPath(location);
  const folder = path.dirname(file);
  const posix = location.platform !== "win32";

  await mkdir(folder, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing folder's mode alone.
  if (posix) await chmod(folder, 0o700);

  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, serialiseCredentials(credentials), { mode: 0o600 });
  if (posix) await chmod(temporary, 0o600);
  await rename(temporary, file);
}

async function tightenIfExposed(file: string): Promise<void> {
  const { mode } = await stat(file);
  if ((mode & 0o077) !== 0) await chmod(file, 0o600);
}

type Parsed =
  | { ok: true; credentials: Credentials }
  | { ok: false; reason: string };

/**
 * The strict reader. Accepts comments, blank lines, and exactly one
 * `token = "..."` and one `api = "..."`, in either order. Nothing else.
 */
export function parseCredentials(text: string): Parsed {
  const values = new Map<string, string>();
  const lines = text.split(/\r?\n/);

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const entry = /^(token|api)\s*=\s*"([^"\\]*)"$/.exec(line);
    if (!entry) {
      return { ok: false, reason: `line ${index + 1} isn't something varis wrote` };
    }
    const [, key, value] = entry as unknown as [string, string, string];
    if (values.has(key)) {
      return { ok: false, reason: `${key} appears twice` };
    }
    values.set(key, value);
  }

  const token = values.get("token");
  const api = values.get("api");
  if (!token || !api) {
    return { ok: false, reason: `${token ? "api" : "token"} is missing` };
  }
  if (!TOKEN_PATTERN.test(token)) {
    return { ok: false, reason: "token isn't a device token" };
  }
  return { ok: true, credentials: { token, api } };
}

export function serialiseCredentials({ token, api }: Credentials): string {
  return `${HEADER}\ntoken = "${token}"\napi = "${api}"\n`;
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}
