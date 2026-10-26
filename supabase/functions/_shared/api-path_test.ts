import { extractPublicApiPath } from "./api-path.ts";

Deno.test("public API path accepts only the exact commerce function suffix", () => {
  const valid = extractPublicApiPath(
    "/functions/v1/commerce-api/v1/device-activation-challenges/abc/exchange",
  );
  if (valid !== "/v1/device-activation-challenges/abc/exchange") {
    throw new Error(`Unexpected public path: ${valid}`);
  }
  for (
    const alias of [
      "/commerce-api/v1/x/v1/stripe/webhook",
      "/commerce-api-other/v1/stripe/webhook",
      "/v1/stripe/webhook",
      "/functions/v1/commerce-api/v1/x/v1/stripe/webhook",
      "/another/commerce-api/v1/stripe/webhook",
      "/functions/v1/not-commerce-api/v1/stripe/webhook",
    ]
  ) {
    try {
      extractPublicApiPath(alias);
    } catch {
      continue;
    }
    throw new Error(`Alias should be rejected: ${alias}`);
  }
});

Deno.test("hosted gateway paths preserve the public path used for device proofs", () => {
  for (
    const endpoint of [
      "time",
      "license-keys",
      "stripe/webhook",
      "devices/abc/refresh",
    ]
  ) {
    const publicPath = `/v1/${endpoint}`;
    if (extractPublicApiPath(`/commerce-api${publicPath}`) !== publicPath) {
      throw new Error("Hosted function path changed the signed public path");
    }
  }
});

Deno.test("both gateway forms enforce exact function and version boundaries", () => {
  for (const prefix of ["/functions/v1/commerce-api", "/commerce-api"]) {
    for (
      const suffix of [
        "/v1",
        "/v1/",
        "/v1/devices/refresh",
        "/v1/devices/current",
      ]
    ) {
      if (extractPublicApiPath(`${prefix}${suffix}`) !== suffix) {
        throw new Error("Canonical public path was not preserved");
      }
    }
    for (
      const suffix of ["", "/", "/v10/time", "-other/v1/time", "/v1/x/v1/time"]
    ) {
      try {
        extractPublicApiPath(`${prefix}${suffix}`);
      } catch {
        continue;
      }
      throw new Error(`Invalid boundary was accepted: ${prefix}${suffix}`);
    }
  }
});
