// Tests for testUrlFor: where varis test sends a service's request.

import { describe, expect, it } from "vitest";
import { testUrlFor } from "../src/lib/base-url.ts";

describe("testUrlFor", () => {
  it("swaps a base_url with a path for test_base_url, without doubling the path", () => {
    expect(
      testUrlFor("https://example.com/api/weather", "https://example.com/api", "http://localhost:3000/api").href,
    ).toBe("http://localhost:3000/api/weather");
  });

  it("drops base_url's path when test_base_url serves the routes at its root", () => {
    expect(
      testUrlFor("https://example.com/api/weather", "https://example.com/api", "http://localhost:3000").href,
    ).toBe("http://localhost:3000/weather");
  });

  it("swaps bare origins", () => {
    expect(
      testUrlFor("https://api.example.com/v1/weather", "https://api.example.com", "http://localhost:3000").href,
    ).toBe("http://localhost:3000/v1/weather");
  });

  it("ignores trailing slashes on either base", () => {
    expect(
      testUrlFor("https://api.example.com/v1/weather", "https://api.example.com/", "http://localhost:3000/").href,
    ).toBe("http://localhost:3000/v1/weather");
  });

  it("maps an endpoint_url equal to base_url to test_base_url", () => {
    expect(
      testUrlFor("https://example.com/api", "https://example.com/api", "http://localhost:3000/api").href,
    ).toBe("http://localhost:3000/api");
  });

  it("matches base_url only on a path boundary", () => {
    expect(
      testUrlFor("https://example.com/apis/weather", "https://example.com/api", "http://localhost:3000").href,
    ).toBe("http://localhost:3000/apis/weather");
  });

  it("keeps the path of an endpoint_url on another host than base_url", () => {
    expect(
      testUrlFor("https://other.example.com/v1/weather", "https://api.example.com", "http://localhost:3000").href,
    ).toBe("http://localhost:3000/v1/weather");
  });

  it("keeps the path when there is no base_url", () => {
    expect(testUrlFor("https://api.example.com/v1/weather", undefined, "http://localhost:3000").href).toBe(
      "http://localhost:3000/v1/weather",
    );
  });

  it("throws on an endpoint_url that isn't a URL", () => {
    expect(() => testUrlFor("not a url", undefined, "http://localhost:3000")).toThrow();
  });
});
