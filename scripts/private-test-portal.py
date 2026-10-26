#!/usr/bin/env python3
"""Private loopback storefront + exact-origin API reverse proxy. No request logging."""
import argparse
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import mimetypes
import ssl
import certifi
from pathlib import Path
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = 'licenses.stuffbyrambo.com'
PORT = 8765
TLS_CONTEXT = ssl.create_default_context(cafile=certifi.where())
LIMIT = 2 * 1024 * 1024
FORWARD = {'accept', 'content-type', 'cookie', 'origin', 'authorization', 'x-csrf-token',
           'idempotency-key', 'x-gf-timestamp', 'x-gf-nonce', 'x-gf-signature'}
HOP = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
       'trailer', 'transfer-encoding', 'upgrade', 'content-length'}

class Handler(BaseHTTPRequestHandler):
    server_version = 'PrivateE2E'
    def log_message(self, *args):
        pass
    def send_bytes(self, status, body, content_type='text/plain; charset=utf-8'):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)
    def route(self):
        host = self.headers.get('Host', '')
        if host not in {f'localhost:{PORT}', f'127.0.0.1:{PORT}'}:
            return self.send_bytes(403, b'Host rejected')
        origin = self.headers.get('Origin')
        if origin and origin not in {f'http://localhost:{PORT}', f'http://127.0.0.1:{PORT}'}:
            return self.send_bytes(403, b'Origin rejected')
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.scheme or parsed.netloc or parsed.fragment or '\\' in self.path:
            return self.send_bytes(400, b'Invalid request target')
        if parsed.path.startswith('/v1/'):
            return self.proxy()
        if self.command not in {'GET', 'HEAD'}:
            return self.send_bytes(405, b'Method rejected')
        decoded = urllib.parse.unquote(parsed.path)
        if decoded == '/':
            decoded = '/license/'
        if not any(decoded.startswith('/' + name + '/') for name in ('license', 'assets', 'legal', 'gesture-flow')):
            return self.send_bytes(404, b'Not found')
        if any(part in {'.', '..'} or part.startswith('.') for part in decoded.split('/') if part):
            return self.send_bytes(404, b'Not found')
        path = (ROOT / decoded.lstrip('/')).resolve()
        if path.is_dir():
            path = (path / 'index.html').resolve()
        if not path.is_relative_to(ROOT) or not path.is_file():
            return self.send_bytes(404, b'Not found')
        body = path.read_bytes()
        if path == ROOT / 'assets/storefront-config.js':
            original = b'apiBaseUrl: "https://licenses.stuffbyrambo.com/v1"'
            if body.count(original) != 1:
                return self.send_bytes(500, b'Unexpected storefront config format')
            body = body.replace(original, b'apiBaseUrl: "/v1"')
        self.send_bytes(200, body, mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
    def proxy(self):
        if self.command not in {'GET', 'POST', 'DELETE', 'OPTIONS'}:
            return self.send_bytes(405, b'Method rejected')
        if self.headers.get('Transfer-Encoding'):
            return self.send_bytes(400, b'Transfer encoding rejected')
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return self.send_bytes(400, b'Invalid length')
        if not 0 <= length <= LIMIT:
            return self.send_bytes(413, b'Request too large')
        body = self.rfile.read(length) if length else None
        headers = {key: value for key, value in self.headers.items() if key.lower() in FORWARD}
        headers['Accept-Encoding'] = 'identity'
        upstream = http.client.HTTPSConnection(UPSTREAM, timeout=30, context=TLS_CONTEXT)
        try:
            upstream.request(self.command, self.path, body=body, headers=headers)
            result = upstream.getresponse()
            payload = result.read(LIMIT + 1)
            if len(payload) > LIMIT:
                return self.send_bytes(502, b'Upstream response too large')
            self.send_response(result.status)
            connection_headers = set((result.getheader('Connection') or '').lower().split(','))
            for key, value in result.getheaders():
                if key.lower() not in HOP | {name.strip() for name in connection_headers}:
                    # Separate Set-Cookie headers stay separate, with all attributes intact.
                    self.send_header(key, value)
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (OSError, http.client.HTTPException):
            self.send_bytes(502, b'Upstream unavailable')
        finally:
            upstream.close()
    do_GET = route
    do_HEAD = route
    do_POST = route
    do_DELETE = route
    do_OPTIONS = route

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'Private portal ready at http://localhost:{PORT}/license/', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
