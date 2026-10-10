// varis publish: builds, then publishes each service in varis.json.
//
// One command takes a new developer all the way: no varis.json runs the init
// flow, which signs in first; a varis.json without a sign-in runs login. Then
// varis build, which must succeed. Then each service is sent on its own, so
// one bad service doesn't hide the others' results, and each is reported as
// created, updated, unchanged, or why it failed.
//
// `varis publish <service_slug>` publishes only that service, for the
// edit-and-republish loop.

import { parseArgs } from "node:util";
import { type ApiError, apiRequest, type ApiRequestFn } from "../lib/api.ts";
import type { Command } from "../lib/command.ts";
import { apiOrigin, type Env } from "../lib/constants.ts";
import {
  type CredentialsLocation,
  defaultLocation,
  readToken,
} from "../lib/credentials.ts";
import { runCommand, type Runner } from "../lib/generator.ts";
import { MANIFEST_FILE, readManifest } from "../lib/manifest.ts";
import type { Output } from "../lib/output.ts";
import { type Prompter, terminalPrompter } from "../lib/prompt.ts";
import { dim, failure, green, red, success } from "../lib/style.ts";
import { buildProject } from "./build.ts";
import { initDeps, runInit } from "./init.ts";
import { loginDeps, runLogin } from "./login.ts";

export type PublishDeps = {
  cwd: string;
  env: Env;
  credentials: CredentialsLocation;
  request: ApiRequestFn;
  prompter: Prompter;
  run: Runner;
  /** Runs varis init. Returns its exit code. */
  setUp: (output: Output) => Promise<number>;
  /** Runs varis login. Returns its exit code. */
  signIn: (output: Output) => Promise<number>;
};

const defaultDeps = (): PublishDeps => {
  const cwd = process.cwd();
  const env = process.env;
  const credentials = defaultLocation();
  const prompter = terminalPrompter();
  const signIn = (output: Output) =>
    runLogin([], output, loginDeps({ env, credentials, request: apiRequest }));
  return {
    cwd,
    env,
    credentials,
    request: apiRequest,
    prompter,
    run: runCommand,
    setUp: (output) =>
      runInit(
        [],
        output,
        initDeps({ cwd, env, credentials, prompter, signIn }),
      ),
    signIn,
  };
};

/**
 * One service as varis build wrote it into varis.json: every field the API's
 * ServiceInput takes (slug, name, description, instructions, service_type,
 * categories, endpoint_url, method, price_cents, version, status,
 * input_schema, output_schema). The CLI reads only `slug`, for its messages
 * and the slug filter, and sends the whole object as written, so a field
 *  the generator adds later reaches the API without a CLI release.
 */
type ManifestService = { slug?: unknown; [field: string]: unknown };

type Published = { id: string; slug: string; unchanged?: boolean };

type Result =
  | { slug: string; outcome: "created" | "updated" | "unchanged"; id: string }
  | { slug: string; outcome: "failed"; error: ApiError };

/** Errors after which no later service can succeed either. */
const STOPPING_KINDS = new Set<ApiError["kind"]>([
  "signed_out",
  "signed_in_elsewhere",
  "damaged_credentials",
  "rejected_token",
  "network",
]);

export async function runPublish(
  args: string[],
  output: Output,
  deps: PublishDeps = defaultDeps(),
): Promise<number> {
  let only: string | undefined;
  try {
    const { positionals } = parseArgs({
      args,
      options: {},
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length > 1) {
      output.err("Give at most one service slug. Run varis publish --help.");
      return 2;
    }
    only = positionals[0];
  } catch (error) {
    output.err(
      `${
        error instanceof Error ? error.message : error
      } Run varis publish --help.`,
    );
    return 2;
  }

  // Set up first, if this project has never been.
  const before = await readManifest(deps.cwd);
  if (before.status === "missing") {
    output.err(`No ${MANIFEST_FILE} yet. Setting up this project first.`);
    output.err("");
    const code = await deps.setUp(output);
    if (code !== 0) return code;
    output.err("");
  } else {
    const token = await readToken(apiOrigin(deps.env), deps.credentials);
    if (token.status !== "signed_in") {
      output.err("You need to sign in first.");
      output.err("");
      const code = await deps.signIn(output);
      if (code !== 0) return code;
      output.err("");
    }
  }

  const built = await buildProject(output, {
    cwd: deps.cwd,
    env: deps.env,
    run: deps.run,
  });
  if (built?.kind !== "built") {
    output.err("Nothing was published.");
    return 1;
  }

  const found = await readManifest(deps.cwd);
  if (found.status !== "found" || !found.manifest.owner_id) {
    output.err(
      failure(output, `${MANIFEST_FILE} has no owner_id. Run varis init.`),
    );
    return 1;
  }
  const owner = found.manifest.owner_id;
  const all = (found.manifest.services ?? []) as ManifestService[];

  let services = all;
  if (only !== undefined) {
    services = all.filter((s) => s.slug === only);
    if (services.length === 0) {
      output.err(
        failure(
          output,
          `${MANIFEST_FILE} does not have a service with the slug ${only}.`,
        ),
      );
      return 1;
    }
  }

  if (services.length === 0) {
    output.out(
      "No services to publish. Define one with the Varis SDK, then run `varis publish`.",
    );
    return 0;
  }

  output.err("");
  const results: Result[] = [];
  for (const service of services) {
    const slug = String(service.slug);
    output.status(`Publishing ${slug}…`);

    const sent = await deps.request<Published>("POST", "/v1/services", {
      auth: "device",
      owner,
      // The whole service, every field, exactly as varis.json holds it.
      body: service,
      env: deps.env,
      credentials: deps.credentials,
    });

    const result: Result = sent.ok
      ? {
        slug,
        id: sent.body.id,
        outcome: sent.status === 201
          ? "created"
          : sent.body.unchanged
          ? "unchanged"
          : "updated",
      }
      : { slug, outcome: "failed", error: sent.error };
    results.push(result);
    reportOne(result, output);

    if (result.outcome === "failed" && STOPPING_KINDS.has(result.error.kind)) {
      const left = services.length - results.length;
      if (left > 0) {
        output.err(
          `Stopped. ${left} service${
            left === 1 ? " wasn't" : "s weren't"
          } sent.`,
        );
      }
      break;
    }
  }

  return summarise(results, services.length, output);
}

function reportOne(result: Result, output: Output): void {
  if (result.outcome === "failed") {
    output.err(red(output, `✗ ${result.slug}`) + `  ${result.error.message}`);
    for (const detail of result.error.details ?? []) {
      output.err(`    ${detail.path}: ${detail.message}`);
    }
    return;
  }
  const id = dim(output, `(${result.id})`);
  if (result.outcome === "unchanged") {
    output.out(dim(output, `· ${result.slug}  unchanged`) + ` ${id}`);
  } else {
    output.out(green(output, `✓ ${result.slug}  ${result.outcome}`) + ` ${id}`);
  }
}

function summarise(results: Result[], total: number, output: Output): number {
  const count = (outcome: Result["outcome"]) =>
    results.filter((r) => r.outcome === outcome).length;
  const failed = count("failed");
  const parts = [
    ["created", count("created")],
    ["updated", count("updated")],
    ["unchanged", count("unchanged")],
    ["failed", failed],
  ].filter(([, n]) => (n as number) > 0).map(([word, n]) => `${n} ${word}`);

  output.out("");
  const line = `${total} service${total === 1 ? "" : "s"}: ${
    parts.join(", ")
  }.`;
  output.out(failed > 0 ? failure(output, line) : success(output, line));
  return failed > 0 ? 1 : 0;
}

export const publish: Command = {
  name: "publish",
  summary: "Build, then publish every service in varis.json",
  usage: `Usage: varis publish [service_slug]

  Builds varis.json from your code, then publishes each service and reports
  created, updated, unchanged, or why it failed. Stops before publishing
  anything if the build fails.

  In a new project, it runs varis init first, which signs you in. So
  varis publish is the only command a new developer needs.

  service_slug  Publish only this service, for example after fixing it.`,
  run: (args, output) => runPublish(args, output),
};
