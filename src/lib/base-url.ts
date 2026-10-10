// The production base URL in varis.json, which varis build joins to each
// service's path. Checked against the rules the Varis API applies to an
// endpoint at publish, so a bad one fails here rather than at publish.

/** Hosts a published endpoint can never live on. Mirrors the Varis API. */
const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "host.docker.internal",
]);

/** Why `value` can't be a base URL, or undefined if it can. */
export function baseUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "isn't a full URL, such as https://api.example.com";
  }
  if (url.protocol !== "https:") return "must use https";
  if (BLOCKED_HOSTS.has(url.hostname)) {
    return "must be your production address, not a local one";
  }
  if (url.search !== "" || value.includes("?")) {
    return "can't include a query string";
  }
  if (url.hash !== "" || value.includes("#")) return "can't include a fragment";
  return undefined;
}

/**
 * Why `value` can't be a test base URL, or undefined if it can. Looser than
 * the production rules: a test server is usually local, so http and
 * localhost are fine. Still a full URL, with no query or fragment, because
 * each service's path is joined to it.
 */
export function testBaseUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "isn't a full URL, such as http://localhost:3000";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "must start with http:// or https://";
  }
  if (url.search !== "" || value.includes("?")) {
    return "can't include a query string";
  }
  if (url.hash !== "" || value.includes("#")) return "can't include a fragment";
  return undefined;
}

/** The form stored in varis.json: no trailing slash. */
export function normaliseBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * Where varis test sends a service's request: endpoint_url with its base_url
 * prefix replaced by test_base_url, so a base_url with a path, such as
 * https://example.com/api, maps to http://localhost:3000/api exactly as
 * written. An endpoint_url outside base_url, or a project without one, keeps
 * its path and moves to test_base_url. Throws when a URL can't be parsed.
 */
export function testUrlFor(
  endpointUrl: string,
  baseUrl: string | undefined,
  testBaseUrl: string,
): URL {
  const testBase = normaliseBaseUrl(testBaseUrl);
  if (baseUrl !== undefined && baseUrl !== "") {
    const base = normaliseBaseUrl(baseUrl);
    // Only on a path boundary: base .../api doesn't own .../apis/weather.
    if (endpointUrl === base || endpointUrl.startsWith(`${base}/`)) {
      return new URL(`${testBase}${endpointUrl.slice(base.length)}`);
    }
  }
  return new URL(`${testBase}${new URL(endpointUrl).pathname}`);
}
