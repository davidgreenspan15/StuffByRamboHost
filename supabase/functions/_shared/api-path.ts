export function extractPublicApiPath(pathname: string): string {
  // Hosted Supabase removes the gateway prefix before invoking the function.
  const prefix = ["/functions/v1/commerce-api", "/commerce-api"].find((
    candidate,
  ) => pathname.startsWith(`${candidate}/`));
  if (!prefix) throw new Error("invalid_function_path");
  const suffix = pathname.slice(prefix.length);
  if (suffix !== "/v1" && !suffix.startsWith("/v1/")) {
    throw new Error("invalid_public_api_path");
  }
  if (suffix.slice(4).includes("/v1/")) {
    throw new Error("nested_api_version_path");
  }
  return suffix;
}
