"""Offline validation for the SEC-002 Cloudflare response-header ruleset.

Stdlib only; no network, no credentials. Usage (from the repository root):
    python3 -I edge/storefront-security/validate_headers.py .

Checks the ruleset shape, evaluates its expression with a small evaluator
for exactly the grammar it uses, and checks that the header CSP never
blocks anything an existing commerce page's meta CSP allows (both policies
are enforced, so the header must be a superset of every page's meta).
"""
from __future__ import annotations

import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

HOSTS = {"stuffbyrambo.com", "www.stuffbyrambo.com"}
ROUTES = ("/gesture-flow", "/license", "/legal")
REQUIRED = {
    "Content-Security-Policy", "Strict-Transport-Security", "X-Frame-Options",
    "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy",
}


def canonical_expression() -> str:
    hosts = " ".join(f'"{h}"' for h in sorted(HOSTS))
    exact = " ".join(f'"{r}"' for r in ROUTES)
    prefixes = " or ".join(
        f'starts_with(lower(http.request.uri.path), "{r}/")' for r in ROUTES)
    return (f"(http.host in {{{hosts}}}) and "
            f"(lower(http.request.uri.path) in {{{exact}}} or {prefixes})")


TOKEN = re.compile(r'\s*(\(|\)|\{|\}|,|"[^"]*"|[A-Za-z_][A-Za-z0-9_.]*)')


class Evaluator:
    """Recursive descent over: expr := term (or term)*; term := atom (and atom)*."""

    def __init__(self, expression: str):
        self.tokens = []
        pos = 0
        while pos < len(expression):
            match = TOKEN.match(expression, pos)
            if not match:
                if expression[pos:].strip() == "":
                    break
                raise ValueError(f"unexpected input at {pos}")
            self.tokens.append(match.group(1))
            pos = match.end()

    def evaluate(self, host: str, path: str) -> bool:
        self.i, self.fields = 0, {"http.host": host, "http.request.uri.path": path}
        result = self.expr()
        if self.i != len(self.tokens):
            raise ValueError("trailing tokens")
        return result

    def take(self, expected: str | None = None) -> str:
        token = self.tokens[self.i]
        if expected is not None and token != expected:
            raise ValueError(f"expected {expected}, got {token}")
        self.i += 1
        return token

    def peek(self) -> str | None:
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def expr(self) -> bool:
        value = self.term()
        while self.peek() == "or":
            self.take()
            value = self.term() or value
        return value

    def term(self) -> bool:
        value = self.atom()
        while self.peek() == "and":
            self.take()
            value = self.atom() and value
        return value

    def field(self) -> str:
        token = self.take()
        if token == "lower":
            self.take("(")
            value = self.field().lower()
            self.take(")")
            return value
        if token not in self.fields:
            raise ValueError(f"unsupported field {token}")
        return self.fields[token]

    def atom(self) -> bool:
        if self.peek() == "(":
            self.take()
            value = self.expr()
            self.take(")")
            return value
        if self.peek() == "starts_with":
            self.take()
            self.take("(")
            value = self.field()
            self.take(",")
            prefix = self.take()[1:-1]
            self.take(")")
            return value.startswith(prefix)
        value = self.field()
        self.take("in")
        self.take("{")
        members = set()
        while self.peek() != "}":
            members.add(self.take()[1:-1])
        self.take("}")
        return value in members


def parse_csp(policy: str) -> dict[str, set[str]]:
    directives = {}
    for part in policy.split(";"):
        words = part.split()
        if words:
            directives[words[0].lower()] = set(words[1:])
    return directives


FETCH = ("connect-src", "img-src", "style-src", "script-src", "font-src", "object-src")


class MetaCsp(HTMLParser):
    def __init__(self):
        super().__init__()
        self.policies = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "meta" and (attributes.get("http-equiv") or "").lower() == "content-security-policy":
            self.policies.append(attributes.get("content") or "")


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    ruleset = json.loads((root / "edge/storefront-security/http_response_headers_transform.ruleset.json").read_text())
    failures: list[str] = []

    def check(ok: bool, message: str) -> None:
        if not ok:
            failures.append(message)

    rules = ruleset.get("rules", [])
    check(len(rules) == 1, "exactly one rule")
    rule = rules[0]
    check(rule.get("action") == "rewrite", "action is rewrite")
    check(rule.get("enabled") is True, "rule enabled in artifact")
    check(rule.get("expression") == canonical_expression(), "expression matches canonical route list")
    headers = rule.get("action_parameters", {}).get("headers", {})
    check(set(headers) == REQUIRED, f"header set is exactly {sorted(REQUIRED)}")
    for name, spec in headers.items():
        check(spec.get("operation") == "set" and isinstance(spec.get("value"), str)
              and "expression" not in spec, f"{name}: static set")
        check("\n" not in spec.get("value", ""), f"{name}: single line")

    hsts = headers["Strict-Transport-Security"]["value"].lower()
    max_age = re.fullmatch(r"max-age=(\d+)", hsts)
    check(bool(max_age) and 0 < int(max_age.group(1)) <= 31536000,
          "HSTS is only a bounded max-age (no includeSubDomains, no preload)")
    check(headers["X-Frame-Options"]["value"] == "DENY", "XFO DENY")
    check(headers["X-Content-Type-Options"]["value"] == "nosniff", "nosniff")
    check(headers["Referrer-Policy"]["value"] == "strict-origin-when-cross-origin", "referrer policy")
    permissions = headers["Permissions-Policy"]["value"]
    for feature in ("camera", "microphone", "payment", "geolocation"):
        check(f"{feature}=()" in permissions, f"Permissions-Policy denies {feature}")

    csp = parse_csp(headers["Content-Security-Policy"]["value"])
    check(csp.get("frame-ancestors") == {"'none'"}, "CSP frame-ancestors 'none'")
    check(csp.get("object-src") == {"'none'"}, "CSP object-src 'none'")
    check(csp.get("base-uri") == {"'none'"}, "CSP base-uri 'none'")
    check("'unsafe-inline'" not in " ".join(" ".join(v) for v in csp.values())
          and "'unsafe-eval'" not in " ".join(" ".join(v) for v in csp.values()),
          "CSP has no unsafe-inline/eval")

    def sources(policy: dict[str, set[str]], directive: str) -> set[str]:
        return policy.get(directive, policy.get("default-src", set()))

    pages = sorted(p for route in ROUTES for p in (root / route.lstrip("/")).rglob("*.html"))
    check(bool(pages), "commerce pages found")
    for page in pages:
        parser = MetaCsp()
        parser.feed(page.read_text())
        rel = page.relative_to(root)
        check(len(parser.policies) == 1, f"{rel}: exactly one meta CSP")
        for policy in parser.policies:
            meta = parse_csp(policy)
            for directive in FETCH + ("default-src", "form-action", "base-uri"):
                allowed_by_meta = sources(meta, directive) - {"'none'"}
                allowed_by_header = sources(csp, directive)
                check(allowed_by_meta <= allowed_by_header,
                      f"{rel}: header {directive} would block {sorted(allowed_by_meta - allowed_by_header)}")

    evaluator = Evaluator(rule["expression"])
    cases = {
        ("stuffbyrambo.com", "/gesture-flow"): True,
        ("stuffbyrambo.com", "/gesture-flow/"): True,
        ("www.stuffbyrambo.com", "/gesture-flow/success.html"): True,
        ("stuffbyrambo.com", "/Gesture-Flow/index.html"): True,
        ("stuffbyrambo.com", "/license"): True,
        ("stuffbyrambo.com", "/license/"): True,
        ("stuffbyrambo.com", "/legal/terms.html"): True,
        ("stuffbyrambo.com", "/"): False,
        ("stuffbyrambo.com", "/index.html"): False,
        ("stuffbyrambo.com", "/assets/storefront.js"): False,
        ("stuffbyrambo.com", "/gesture-flowx"): False,
        ("stuffbyrambo.com", "/gesture-flow.html"): False,
        ("stuffbyrambo.com", "/licenses/"): False,
        ("stuffbyrambo.com", "/legalese"): False,
        ("stuffbyrambo.com", "/apps/gesture-flow/"): False,
        ("licenses.stuffbyrambo.com", "/license/"): False,
        ("stuffbyrambo.com.evil.example", "/legal/"): False,
        ("dev.stuffbyrambo.com", "/gesture-flow/"): False,
    }
    for (host, path), expected in cases.items():
        check(evaluator.evaluate(host, path) is expected, f"match {host}{path} -> {expected}")

    if failures:
        for failure in failures:
            print(f"FAIL: {failure}")
        return 1
    print(f"PASS: ruleset shape, {len(cases)} host/path cases, {len(pages)} pages' meta CSP covered by header")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
