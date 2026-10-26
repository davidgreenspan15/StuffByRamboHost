import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pages = [
  "index.html",
  "gesture-flow/index.html",
  "gesture-flow/success.html",
  "gesture-flow/canceled.html",
  "gesture-flow/compatibility.html",
  "license/index.html",
  "legal/terms.html",
  "legal/refunds.html",
  "legal/privacy.html",
  "red-tees/privacy.html"
];
const commercePages = [
  "gesture-flow/index.html",
  "gesture-flow/success.html",
  "gesture-flow/canceled.html",
  "license/index.html"
];
const variationPages = ["variation-a.html", "variation-b.html", "variation-c.html", "variation-d.html", "variation-e.html"];
const failures = [];
const commerceOnly = process.argv.includes("--commerce-only");

function collectHtmlPages(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if ([".git", ".wrangler", "node_modules"].includes(entry.name)) {
      return [];
    }
    const relativePath = join(prefix, entry.name);
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectHtmlPages(absolutePath, relativePath);
    }
    return entry.isFile() && entry.name.endsWith(".html") ? [relativePath] : [];
  });
}

function fail(message) {
  failures.push(message);
}

function read(relativePath) {
  const absolutePath = join(root, relativePath);
  if (!existsSync(absolutePath)) {
    fail(`Missing required file: ${relativePath}`);
    return "";
  }
  return readFileSync(absolutePath, "utf8");
}

function internalTarget(reference, sourcePage) {
  const value = reference.split("#")[0].split("?")[0];
  if (!value || value.startsWith("#") || /^[a-z]+:/i.test(value) || value.startsWith("//")) {
    return null;
  }

  let target = value.startsWith("/")
    ? join(root, decodeURIComponent(value.slice(1)))
    : resolve(dirname(join(root, sourcePage)), decodeURIComponent(value));

  if (value.endsWith("/") || (existsSync(target) && statSync(target).isDirectory())) {
    target = join(target, "index.html");
  } else if (!extname(target) && !existsSync(target)) {
    target = join(target, "index.html");
  }
  return target;
}

for (const page of pages) {
  const html = read(page);
  if (!html) {
    continue;
  }
  if (/(?:two|2) active Macs(?: you own or control)? per paid license|paid v3 entitlement supports (?:two|2) active Macs/i.test(html)) {
    fail(`${page}: stale two-Mac paid-license copy`);
  }

  if (!/<meta http-equiv="Content-Security-Policy"/i.test(html)) {
    fail(`${page}: missing Content Security Policy meta`);
  }
  if (!/<a class="skip-link" href="#main-content">/i.test(html)) {
    fail(`${page}: missing skip link`);
  }
  if (!/<main id="main-content"/i.test(html)) {
    fail(`${page}: missing main landmark target`);
  }
  if (/\son(?:click|change|submit|load|error)=/i.test(html)) {
    fail(`${page}: inline event handler is not allowed`);
  }
  if (/\bhttp:\/\//i.test(html)) {
    fail(`${page}: insecure HTTP URL found`);
  }

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicateIds.length) {
    fail(`${page}: duplicate id(s): ${[...new Set(duplicateIds)].join(", ")}`);
  }

  for (const match of html.matchAll(/<(?:input|select|textarea)\b[^>]*\sid="([^"]+)"[^>]*>/gi)) {
    const id = match[1];
    if (!new RegExp(`<label\\b[^>]*\\sfor="${id}"`, "i").test(html)) {
      fail(`${page}: form control #${id} has no associated label`);
    }
  }

  for (const match of html.matchAll(/<button\b([^>]*)>/gi)) {
    if (!/\stype="(?:button|submit|reset)"/i.test(match[1])) {
      fail(`${page}: button missing an explicit type`);
    }
  }

  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/gi)) {
    const reference = match[1];
    const target = internalTarget(reference, page);
    if (target && !existsSync(target)) {
      fail(`${page}: broken internal reference ${reference}`);
    }
  }
}

for (const page of commercePages) {
  const html = read(page);
  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const src = match[1].match(/\ssrc="([^"]+)"/i);
    if (!src || !src[1].startsWith("/assets/")) {
      fail(`${page}: commerce script must be a local /assets resource`);
    }
  }
  for (const match of html.matchAll(/<link\b([^>]*\srel="stylesheet"[^>]*)>/gi)) {
    const href = match[1].match(/\shref="([^"]+)"/i);
    if (!href || !href[1].startsWith("/assets/")) {
      fail(`${page}: commerce stylesheet must be a local /assets resource`);
    }
  }
}

const publicationPages = commerceOnly
  ? [...commercePages, "legal/terms.html", "legal/refunds.html", "legal/privacy.html", "gesture-flow/compatibility.html", ...collectHtmlPages(join(root, "legal/versions"), "legal/versions")]
  : collectHtmlPages(root);
for (const page of publicationPages) {
  const html = read(page);
  if (!/<meta http-equiv="Content-Security-Policy"/i.test(html)) {
    fail(`${page}: every published HTML page requires a Content Security Policy`);
  }
  if (/cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(html)) {
    fail(`${page}: third-party runtime/font dependency remains on the shared origin`);
  }
  if (/<script\b[^>]*\ssrc="(?:https?:)?\/\//i.test(html)) {
    fail(`${page}: third-party script runtime is not allowed on the shared origin`);
  }
  if (/<link\b[^>]*\srel="stylesheet"[^>]*\shref="(?:https?:)?\/\//i.test(html)) {
    fail(`${page}: third-party runtime stylesheet is not allowed on the shared origin`);
  }
  if (/<script\b(?![^>]*\ssrc=)[^>]*>/i.test(html)) {
    fail(`${page}: inline script is not allowed; use a CSP-compatible local asset`);
  }
}

for (const page of variationPages) {
  const html = read(page);
  if (!html.includes('href="/assets/legacy-utilities.css"') || !html.includes('src="/assets/variation-effects.js"')) {
    fail(`${page}: localized visual utilities and effects are required`);
  }
}

const home = read("index.html");
if (/cdn\.tailwindcss\.com|fonts\.googleapis\.com|<script\b/i.test(home)) {
  fail("index.html: homepage must not load third-party runtime code");
}

const purchase = read("gesture-flow/index.html");
if (/\$\s*\d|USD\s*\d|\d+\.\d{2}\s*USD/i.test(purchase)) {
  fail("gesture-flow/index.html: purchase price must come from the catalog, not static HTML");
}
for (const requiredId of ["accept-terms", "accept-refunds", "accept-compatibility", "purchase-button"]) {
  if (!purchase.includes(`id="${requiredId}"`)) {
    fail(`gesture-flow/index.html: missing required checkout control #${requiredId}`);
  }
}

const portal = read("license/index.html");
for (const requiredId of ["continue-magic-link", "activation-terms", "activation-compatibility", "device-list", "refund-form", "refund-order"]) {
  if (!portal.includes(`id="${requiredId}"`)) {
    fail(`license/index.html: missing required portal control #${requiredId}`);
  }
}

const config = read("assets/storefront-config.js");
for (const value of [
  "https://licenses.stuffbyrambo.com/v1",
  'catalog: "/catalog/gesture-flow"',
  'checkoutSessions: "/checkout-sessions"',
  'checkoutStatus: "/checkout-status"',
  'magicLink: "/portal/magic-link"',
  'session: "/portal/session"',
  'me: "/portal/me"',
  'refundRequests: "/portal/refund-requests"',
  'activationApprovals: "/portal/activations"',
  'devices: "/portal/devices"'
]) {
  if (!config.includes(value)) {
    fail(`assets/storefront-config.js: missing contract value ${value}`);
  }
}

const client = read("assets/storefront.js");
for (const value of [
  'credentials: "include"',
  '"X-CSRF-Token"',
  '"Idempotency-Key"',
  'type: "email"',
  'fragment.get("token_hash")',
  "catalogPoliciesMatch(payload)",
  "orderId",
  "renderRefundOrders(payload)"
]) {
  if (!client.includes(value)) {
    fail(`assets/storefront.js: missing security control ${value}`);
  }
}
if ((client.match(/"Idempotency-Key"/g) || []).length < 4) {
  fail("assets/storefront.js: state-changing commerce actions require idempotency keys");
}
if (/localStorage|sessionStorage|console\.(?:log|warn|error)/.test(client)) {
  fail("assets/storefront.js: must not persist portal tokens or emit console logging");
}
if (!/\^\[A-Za-z0-9_-\]\{32,256\}\$/.test(client)) {
  fail("assets/storefront.js: magic-link token hash must be strictly validated");
}
if (!client.includes('url.searchParams.has("token_hash")') || !client.includes("linkValues.tokenHashInQuery")) {
  fail("assets/storefront.js: query-string magic-link credentials must fail closed");
}

const policyManifest = JSON.parse(read("docs/commerce/production-policy-manifest.json"));
const seed = read("supabase/seed.sql");
const productionPolicy = read("scripts/production-policy.sql");
if (!config.includes(policyManifest.policySetVersion)) {
  fail("Storefront config must match the prepared policy set version");
}
for (const [kind, policy] of Object.entries(policyManifest.documents)) {
  const contents = read(policy.path);
  const immutable = read(policy.immutablePath);
  const actualHash = createHash("sha256").update(contents).digest("hex");
  if (!contents.includes(policy.version) || !config.includes(policy.version)) {
    fail(`${policy.path}: policy version must match the centralized storefront config`);
  }
  if (contents !== immutable || actualHash !== policy.sha256 || !productionPolicy.includes(policy.sha256)) {
    fail(`${policy.path}: prepared policy bytes, immutable copy and database evidence must match`);
  }
  const previous = read(`legal/versions/2026-07-13/${kind}.html`);
  const previousHash = createHash("sha256").update(previous).digest("hex");
  if (previousHash !== policyManifest.previousHashes[kind] || !seed.includes(previousHash)) {
    fail(`${kind}: historical accepted bytes and original seed hash must remain unchanged`);
  }
}

if (failures.length) {
  process.stderr.write(`Storefront validation failed (${failures.length}):\n`);
  failures.forEach((failure) => process.stderr.write(`- ${failure}\n`));
  process.exit(1);
}

process.stdout.write(`Storefront validation passed for ${pages.length} primary pages and ${commerceOnly ? "the scoped commerce/policy" : "every discovered HTML"} security surface.\n`);
