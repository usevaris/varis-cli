// varis test <service_slug>: calls a service on the developer's own running
// server, exactly as the Varis gateway would, before they publish.
//
// WHAT IT CATCHES
// The failures that make a real call fail, and so refund its charge:
//   - an output that doesn't match the service's output schema, which the
//     gateway treats as the provider not delivering;
//   - an endpoint that errors, redirects, times out, or answers without JSON.
// It also proves the handler's verifyRequest is wired correctly, because the
// request is signed and checked the same way a real one is.
//
// WHAT IT DOES, IN ORDER
//   1. Reads the service from varis.json, and test_base_url, which says where
//      the developer's server runs (usually http://localhost:3000). There is
//      no production testing: without test_base_url it stops and says how to
//      set it.
//   2. Works out the URL: the service's endpoint_url with its base_url
//      prefix replaced by test_base_url. With base_url
//      https://example.com/api, https://example.com/api/weather becomes
//      http://localhost:3000/api/weather when test_base_url is
//      http://localhost:3000/api. Without a matching base_url, the path of
//      endpoint_url is joined to test_base_url.
//   3. Takes the input from --input or --input-file and validates it against
//      the input schema, as the gateway does before it calls a provider. A
//      bad input is never sent.
//   4. Builds the request exactly as the gateway does: GET puts the input in
//      the query string, POST sends it as a JSON body.
//   5. Signs it with a throwaway key and opens the loopback listener the SDK
//      checks that signature against. src/lib/test-signing.ts explains how,
//      and why that's safe.
//   6. Sends it, with the gateway's 30-second timeout and no redirects.
//   7. Validates the response against the output schema, and prints the
//      output, or exactly what would make a real call fail.
//
// It reads varis.json as it is and doesn't run varis build first, so a test
// is instant. After changing a definition, run varis build, then test.
//
// Nothing here touches the Varis API: no sign-in, no network beyond the
// developer's own machine, nothing recorded, nothing charged.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { testUrlFor } from "../lib/base-url.ts";
import type { Command } from "../lib/command.ts";
import { MANIFEST_FILE, readManifest } from "../lib/manifest.ts";
import type { Output } from "../lib/output.ts";
import { toQueryString } from "../lib/query-string.ts";
import { type SchemaProblem, validate } from "../lib/schema.ts";
import { bold, dim, failure, success, yellow } from "../lib/style.ts";
import {
  createTestSigner,
  LISTENER_HOST,
  LISTENER_PORT,
  type ListenResult,
  listenForKeyRequests,
  type TestSigner,
} from "../lib/test-signing.ts";
import { VERSION } from "../lib/version.ts";

/** The gateway gives a provider this long to answer, so the test does too. */
const TIMEOUT_MS = 30_000;

/** A response body is shown up to this many characters, then cut. */
const MAX_SHOWN_BODY = 2_000;

/**
 * Everything the command reaches outside itself. The tests swap these to run
 * a whole test call against an in-process server, or on a spare port.
 */
export type TestDeps = {
  cwd: string;
  fetch: typeof fetch;
  createSigner: () => TestSigner;
  listen: (signer: TestSigner) => Promise<ListenResult>;
  /** Milliseconds, for the timing in the success line. */
  now: () => number;
};

const defaultDeps = (): TestDeps => ({
  cwd: process.cwd(),
  fetch,
  createSigner: createTestSigner,
  listen: (signer) => listenForKeyRequests(signer),
  now: () => Date.now(),
});

/**
 * The fields of one varis.json service that a test reads. The generator
 * writes them all; `unknown` because a developer may have edited the file
 * by hand.
 */
type ManifestService = {
  slug?: unknown;
  endpoint_url?: unknown;
  method?: unknown;
  input_schema?: unknown;
  output_schema?: unknown;
};

type Args = { slug: string; input?: string; inputFile?: string };

function parseCommandArgs(args: string[]): Args | { error: string } {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        input: { type: "string" },
        "input-file": { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length !== 1) {
      return { error: "Give one service slug, for example varis test weather." };
    }
    if (values.input !== undefined && values["input-file"] !== undefined) {
      return { error: "Give --input or --input-file, not both." };
    }
    return {
      slug: positionals[0]!,
      input: values.input,
      inputFile: values["input-file"],
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runTest(
  args: string[],
  output: Output,
  deps: TestDeps = defaultDeps(),
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if ("error" in parsed) {
    output.err(`${parsed.error} Run varis test --help.`);
    return 2;
  }

  // 1. The service, and where the developer's server runs.
  const found = await readManifest(deps.cwd);
  if (found.status === "missing") {
    output.err(failure(output, `No ${MANIFEST_FILE} in this folder. Run varis init first.`));
    return 1;
  }
  if (found.status === "invalid") {
    output.err(failure(output, `${MANIFEST_FILE} can't be read: ${found.reason}.`));
    return 1;
  }
  const manifest = found.manifest;

  if (typeof manifest.test_base_url !== "string" || manifest.test_base_url === "") {
    output.err(failure(output, `No test_base_url in ${MANIFEST_FILE}.`));
    output.err(
      "varis test calls your own running server, so it needs its address. Set it once:",
    );
    output.err("");
    output.err("  varis init --test-base-url http://localhost:3000");
    return 1;
  }

  const services = (manifest.services ?? []) as ManifestService[];
  const service = services.find((s) => s?.slug === parsed.slug);
  if (!service) {
    output.err(
      failure(
        output,
        `${MANIFEST_FILE} has no service with the slug ${parsed.slug}. If you just defined it, run varis build.`,
      ),
    );
    return 1;
  }

  // 2. The URL. endpoint_url is where the service runs in production; a test
  // goes to the developer's server instead, by swapping base_url for
  // test_base_url (testUrlFor explains the fallback). endpoint_url never
  // carries a query string: publish forbids one, because the gateway owns the
  // query of a GET service.
  let target: URL;
  try {
    target = testUrlFor(
      String(service.endpoint_url),
      typeof manifest.base_url === "string" ? manifest.base_url : undefined,
      manifest.test_base_url,
    );
  } catch {
    output.err(
      failure(
        output,
        `Can't build a test URL from ${parsed.slug}'s endpoint_url and test_base_url. Check both in ${MANIFEST_FILE}.`,
      ),
    );
    return 1;
  }

  // 3. The input, checked before anything is sent, as the gateway checks it.
  const input = await readInput(parsed, service, deps.cwd, output);
  if (input === undefined) return 1;

  const inputCheck = validate(service.input_schema ?? {}, input);
  if (!inputCheck.ok) {
    if ("invalidSchema" in inputCheck) {
      output.err(
        failure(output, `${parsed.slug}'s input schema is invalid: ${inputCheck.invalidSchema}`),
      );
    } else {
      output.err(
        failure(output, `The input doesn't match ${parsed.slug}'s input schema, so nothing was sent.`),
      );
      printProblems(inputCheck.problems, output);
    }
    return 1;
  }

  // 4. The request, built exactly as the gateway builds it. varis.json
  // writes GET or POST; anything else is treated as the API's default, GET.
  const method = service.method === "POST" ? "POST" : "GET";
  let rawBody = "";
  if (method === "GET") {
    try {
      target.search = toQueryString(input, service.input_schema);
    } catch (error) {
      output.err(
        failure(
          output,
          `${parsed.slug} is a GET service, so its input must fit in a query string: ${
            error instanceof Error ? error.message : String(error)
          }.`,
        ),
      );
      return 1;
    }
  } else {
    // Serialised once. These exact bytes are both signed and sent: sending a
    // second serialisation could differ, and the signature would fail.
    rawBody = JSON.stringify(input);
  }

  // 5. A key for this one request, and the listener that vouches for it.
  const signer = deps.createSigner();
  const listening = await deps.listen(signer);
  if (!listening.ok) {
    output.err(failure(output, listening.message));
    return 1;
  }
  const { listener } = listening;

  output.err(`${bold(output, method)} ${target.href}`);
  output.err(dim(output, `Request ID ${signer.requestId}`));

  // 6. Send it. The listener stays open until the whole response has
  // arrived, because the server fetches the key while handling the request.
  // It closes in `finally`, whatever happens, so the port is free for the
  // next test and the process can exit.
  const started = deps.now();
  let response: Response;
  let text: string;
  let keyFetches: number;
  try {
    response = await deps.fetch(target.href, {
      method,
      headers: {
        ...signer.sign({
          method,
          // Signed exactly as the URL goes out: URL serialises the path and
          // query the same way the gateway does.
          pathAndQuery: `${target.pathname}${target.search}`,
          rawBody,
        }),
        Accept: "application/json",
        "User-Agent": `varis-cli/${VERSION} (varis test)`,
        // The gateway sends Content-Type only with a body. So does the test,
        // so a handler that trips over it fails here, not in production.
        ...(method === "POST" && { "Content-Type": "application/json" }),
      },
      body: method === "POST" ? rawBody : undefined,
      // The gateway doesn't follow redirects, since a redirect could send a
      // signed request somewhere the provider never meant. A service that
      // redirects fails in production, so it fails here too.
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    return reportUnreachable(error, target, listener.fetches(), output);
  } finally {
    keyFetches = listener.fetches();
    await listener.close();
  }
  const elapsed = deps.now() - started;

  // 7. Judge the response the way the gateway would.
  if (response.status < 200 || response.status >= 300) {
    return reportStatus(response, text, keyFetches, output);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    output.err(
      failure(
        output,
        `Your server answered ${response.status}, but not with JSON. Varis would count this as a failed call and refund it.`,
      ),
    );
    showBody(text, output);
    return 1;
  }

  const outputCheck = validate(service.output_schema ?? {}, payload);
  if (!outputCheck.ok) {
    if ("invalidSchema" in outputCheck) {
      output.err(
        failure(output, `${parsed.slug}'s output schema is invalid: ${outputCheck.invalidSchema}`),
      );
      return 1;
    }
    output.err(
      failure(
        output,
        `The response doesn't match ${parsed.slug}'s output schema. Varis would count this as a failed call and refund it.`,
      ),
    );
    printProblems(outputCheck.problems, output);
    showBody(JSON.stringify(payload, null, 2), output);
    return 1;
  }

  output.err(
    success(output, `${parsed.slug} passed: ${response.status} in ${elapsed} ms, and the output matches its schema.`),
  );
  // Messages go to stderr and the output alone to stdout, so
  // `varis test weather | jq .temp_c` works.
  output.out(JSON.stringify(payload, null, 2));
  return 0;
}

/**
 * The parsed input, or undefined after saying why there isn't one.
 *
 * With neither flag, it sends {} when the input schema has no required
 * fields, so a service that takes no input needs no flag at all. When fields
 * are required, it names them and shows the flag to use, rather than sending
 * a request that's bound to fail.
 */
async function readInput(
  parsed: Args,
  service: ManifestService,
  cwd: string,
  output: Output,
): Promise<unknown | undefined> {
  let text = parsed.input;
  let source = "--input";

  if (parsed.inputFile !== undefined) {
    source = parsed.inputFile;
    try {
      text = await readFile(path.resolve(cwd, parsed.inputFile), "utf8");
    } catch {
      output.err(failure(output, `Can't read the input file ${parsed.inputFile}.`));
      return undefined;
    }
  }

  if (text === undefined) {
    const required = (service.input_schema as { required?: unknown } | null | undefined)
      ?.required;
    if (Array.isArray(required) && required.length > 0) {
      output.err(
        failure(output, `${parsed.slug} needs input: ${required.join(", ")}. Give it as JSON:`),
      );
      output.err("");
      output.err(`  varis test ${parsed.slug} --input '${exampleInput(required)}'`);
      output.err(`  varis test ${parsed.slug} --input-file input.json`);
      return undefined;
    }
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    output.err(failure(output, `The input from ${source} isn't valid JSON.`));
    return undefined;
  }
}

/** {"city":"…"}, to show the shape --input takes. */
function exampleInput(required: unknown[]): string {
  return JSON.stringify(Object.fromEntries(required.map((key) => [String(key), "…"])));
}

/** fetch threw: the server is down, unreachable, or too slow. */
function reportUnreachable(
  error: unknown,
  target: URL,
  keyFetches: number,
  output: Output,
): number {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    output.err(
      failure(
        output,
        `Your server didn't answer within ${TIMEOUT_MS / 1000} seconds. Varis would count this as a timeout and refund the call.`,
      ),
    );
    return 1;
  }
  output.err(
    failure(
      output,
      `Couldn't reach your server at ${target.origin}. Is it running? test_base_url in ${MANIFEST_FILE} says it's there.`,
    ),
  );
  if (keyFetches > 0) {
    output.err(dim(output, "It fetched the test key, then dropped the connection."));
  }
  return 1;
}

/**
 * A redirect or an error status. A 401 gets the most help: it usually means
 * verifyRequest said no, and whether the server fetched the test key tells
 * two very different causes apart.
 */
function reportStatus(
  response: Response,
  text: string,
  keyFetches: number,
  output: Output,
): number {
  const status = response.status;

  if (status >= 300 && status < 400) {
    const location = response.headers.get("location");
    output.err(
      failure(
        output,
        `Your server redirected (${status})${location ? ` to ${location}` : ""}. Varis doesn't follow redirects, so point the service at the final address.`,
      ),
    );
    return 1;
  }

  output.err(
    failure(output, `Your server answered ${status}. Varis would count this as a failed call and refund it.`),
  );

  if (status === 401) {
    output.err("");
    if (keyFetches === 0) {
      // Nothing asked the listener, so verifyRequest never tried the test
      // key: it's missing, too old to know test requests, or can't reach
      // this machine's loopback.
      output.err(
        yellow(output, "Your server never fetched the test key, so it couldn't verify the request. Either:"),
      );
      output.err("  - the handler doesn't call verifyRequest from @usevaris/sdk 0.1.0 or later, or");
      output.err(
        `  - your server can't reach ${LISTENER_HOST}:${LISTENER_PORT} on this machine. That happens when it runs in`,
      );
      output.err(
        "    Docker (run varis test inside the container) or under wrangler dev --remote (drop --remote).",
      );
    } else {
      // The key was fetched, so the signature was checked and didn't match:
      // the request changed between the wire and verifyRequest.
      output.err(
        yellow(output, "Your server fetched the test key, but the signature didn't match. Usually one of:"),
      );
      output.err("  - middleware rewrote the path or query before verifyRequest saw it;");
      output.err("  - the body was read or parsed before calling verifyRequest.");
      output.err("verifyRequest must see the request exactly as it arrived.");
    }
  }

  if (text.trim() !== "") showBody(text, output);
  return 1;
}

function printProblems(problems: SchemaProblem[], output: Output): void {
  for (const problem of problems) {
    output.err(`  ${problem.path}  ${problem.message}`);
  }
}

function showBody(text: string, output: Output): void {
  const shown = text.length > MAX_SHOWN_BODY ? `${text.slice(0, MAX_SHOWN_BODY)}…` : text;
  output.err("");
  output.err("Your server sent:");
  output.err(dim(output, shown));
}

export const test: Command = {
  name: "test",
  summary: "Call a service on your own server, as Varis would",
  usage: `Usage: varis test <service_slug> [--input '<json>' | --input-file <path>]

  Calls the service on your own running server, at test_base_url in
  varis.json, exactly as Varis would in production: the same method, the
  same signed request, the same checks on the input and the output. Prints
  the output, or exactly what would make a real call fail. Nothing is
  published, charged, or recorded.

  Set test_base_url once, for example:
    varis init --test-base-url http://localhost:3000

  It reads varis.json as it is. After changing a service, run varis build
  first.

  --input '<json>'     The input to send, as JSON.
  --input-file <path>  Read the input from a JSON file.

  With neither, it sends {} when the service needs no input.`,
  run: (args, output) => runTest(args, output),
};
