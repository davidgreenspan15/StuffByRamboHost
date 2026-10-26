import { ApiError } from "./http.ts";

export function stringField(
  body: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number; pattern?: RegExp } = {},
): string {
  const value = body[key];
  const min = options.min ?? 1;
  const max = options.max ?? 500;
  if (
    typeof value !== "string" || value.length < min || value.length > max ||
    (options.pattern && !options.pattern.test(value))
  ) {
    throw new ApiError(400, "invalid_request", `Field ${key} is invalid.`);
  }
  return value;
}

export function booleanTrueField(
  body: Record<string, unknown>,
  key: string,
): true {
  if (body[key] !== true) {
    throw new ApiError(
      400,
      "acceptance_required",
      `Field ${key} must be accepted.`,
    );
  }
  return true;
}

export function objectField(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = body[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_request", `Field ${key} is invalid.`);
  }
  return value as Record<string, unknown>;
}

export function optionalObjectField(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  if (body[key] === undefined) return undefined;
  return objectField(body, key);
}

export function uuidField(body: Record<string, unknown>, key: string): string {
  return stringField(body, key, {
    pattern:
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  });
}

export function uuidPath(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) {
    throw new ApiError(404, "not_found", "Resource was not found.");
  }
  return value;
}

export function exactKeys(
  body: Record<string, unknown>,
  allowed: string[],
): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new ApiError(
      400,
      "unexpected_field",
      "Request contains an unexpected field.",
    );
  }
}
