#!/usr/bin/env python3
"""Developer server for Studio: static public/ plus CORS-adding proxies.

    python3 tools/studio_dev.py --proxy forgejo=https://forgejo.example/api/v1 \
        --proxy es=http://es.example:9200

Then in Studio settings point the repository API at
http://localhost:8000/proxy/forgejo (and Elastic at .../proxy/es).
Development only; never deployed.
"""
import argparse
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import HTTPServer, SimpleHTTPRequestHandler

CORS = [("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Headers", "Authorization, PRIVATE-TOKEN, Content-Type"),
        ("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")]
FORWARD = ("Content-Type", "Authorization", "PRIVATE-TOKEN", "Accept")
STUDIO = "/studio/"


def proxy_error(url, exc):
    """A legible 502 for an upstream that could not be reached at all."""
    reason = getattr(exc, "reason", None) or exc
    body = "proxy error: %s: %s" % (url, reason)
    return 502, [("Content-Type", "text/plain; charset=utf-8")], body.encode("utf-8")


def default_opener(req):
    # The internal CA is private, so a verified context would reject every
    # https upstream; main() warns about this at startup.
    ctx = ssl._create_unverified_context()
    try:
        resp = urllib.request.urlopen(req, context=ctx, timeout=60)
    except urllib.error.HTTPError as exc:
        return exc.code, list(exc.headers.items()), exc.read()
    except OSError as exc:
        # URLError, socket.timeout and ssl.SSLError are all OSError:
        # connection refused, DNS failure, TLS handshake, read timeout.
        return proxy_error(req.get_full_url(), exc)
    try:
        return resp.status, list(resp.getheaders()), resp.read()
    except OSError as exc:
        return proxy_error(req.get_full_url(), exc)
    finally:
        resp.close()


def parse_proxies(pairs):
    """Turn ['name=https://target/base', ...] into {name: target}."""
    proxies = {}
    for pair in pairs or []:
        if "=" not in pair:
            raise ValueError("--proxy expects name=url, got %r" % (pair,))
        name, url = pair.split("=", 1)
        if not name or not url:
            raise ValueError("--proxy expects name=url, got %r" % (pair,))
        proxies[name] = url
    return proxies


def build_handler(root, proxies, opener, studio_src=None):
    """Build a request handler serving `root`, proxying /proxy/<name>/...

    `opener(urllib.request.Request) -> (status, headers, body)` is injected
    so tests never touch the network.
    """
    root = os.path.abspath(root)

    class Handler(SimpleHTTPRequestHandler):
        def _overlay_path(self, clean):
            """Source-tree path for /studio/<rel>, or None."""
            if not studio_src or not clean.startswith(STUDIO):
                return None
            rel = urllib.parse.unquote(clean[len(STUDIO):])
            parts = [p for p in rel.split("/") if p not in ("", ".", "..")]
            if not parts or clean.endswith("/"):
                parts.append("index.html")
            candidate = os.path.join(studio_src, *parts)
            return candidate if os.path.isfile(candidate) else None

        def translate_path(self, path):
            clean = path.split("?", 1)[0].split("#", 1)[0]
            overlay = self._overlay_path(clean)
            if overlay is not None:
                return overlay
            # SimpleHTTPRequestHandler(directory=...) is 3.7+, and the floor
            # here is 3.6: rebase its cwd-relative answer onto `root`.
            rel = SimpleHTTPRequestHandler.translate_path(self, path)
            base = getattr(self, "directory", None) or os.getcwd()
            return os.path.join(root, os.path.relpath(rel, base))

        def _proxy_target(self):
            # Split the query off first so /proxy/<name>?qs (no trailing
            # slash) still resolves the name.
            path, mark, query = self.path.partition("?")
            parts = path.split("/", 3)   # '', 'proxy', name, rest
            if len(parts) < 3 or parts[1] != "proxy" or parts[2] not in proxies:
                return None
            rest = parts[3] if len(parts) > 3 else ""
            return proxies[parts[2]].rstrip("/") + "/" + rest + mark + query

        def _send(self, status, headers, body):
            self.send_response(status)
            for key, value in headers:
                if key.lower() in ("content-type",):
                    self.send_header(key, value)
            for key, value in CORS:
                self.send_header(key, value)
            if status != 204:
                # A 204 carries no body, and no Content-Length either.
                self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _forward(self):
            target = self._proxy_target()
            if target is None:
                self._send(404, [], b"unknown proxy")
                return
            # Chunked request bodies (Transfer-Encoding: chunked) are not
            # supported; Studio never sends one.
            length = int(self.headers.get("Content-Length") or 0)
            data = self.rfile.read(length) if length else None
            if data is None and self.command in ("POST", "PUT"):
                # An empty write body still needs a declared length, or
                # upstreams that insist on one answer 411.
                data = b""
            req = urllib.request.Request(target, data=data, method=self.command)
            if data == b"":
                req.add_header("Content-Length", "0")
            for key in FORWARD:
                if self.headers.get(key):
                    req.add_header(key, self.headers[key])
            try:
                status, headers, body = opener(req)
            except Exception as exc:
                # Never drop the connection: an unanswered request looks
                # exactly like the CORS failure this proxy exists to remove.
                sys.stderr.write("proxy error: %s: %s\n" % (target, exc))
                status, headers, body = proxy_error(target, exc)
            self._send(status, headers, body)

        def end_headers(self):
            # Live edits of the sources must show without a hard refresh.
            self.send_header("Cache-Control", "no-store")
            SimpleHTTPRequestHandler.end_headers(self)

        def do_OPTIONS(self):
            if self.path.startswith("/proxy/"):
                self._send(204, [], b"")
            else:
                self._send(404, [], b"")

        def do_GET(self):
            if self.path.startswith("/proxy/"):
                self._forward()
            else:
                SimpleHTTPRequestHandler.do_GET(self)

        def do_HEAD(self):
            if self.path.startswith("/proxy/"):
                self._forward()
            else:
                SimpleHTTPRequestHandler.do_HEAD(self)

        def do_POST(self):
            self._forward()

        do_PUT = do_POST
        do_DELETE = do_POST

        def log_message(self, fmt, *args):
            sys.stderr.write("%s %s\n" % (self.command, self.path))

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--root", default="public")
    parser.add_argument("--proxy", action="append", default=[],
                        metavar="NAME=URL",
                        help="expose <URL> at /proxy/NAME/ with CORS headers")
    parser.add_argument("--studio-src", default=None, metavar="PATH",
                        help="serve /studio/<rel> from PATH/<rel> when present")
    args = parser.parse_args()
    try:
        proxies = parse_proxies(args.proxy)
    except ValueError as exc:
        parser.error(str(exc))
    root = os.path.abspath(args.root)
    if not os.path.isdir(root):
        parser.error("--root is not a directory: %s" % root)
    if any(url.startswith("https://") for url in proxies.values()):
        sys.stderr.write(
            "warning: https proxy targets use an unverified TLS context "
            "(the internal CA is private); development only\n")
    handler = build_handler(root, proxies, default_opener, args.studio_src)
    server = HTTPServer(("127.0.0.1", args.port), handler)
    sys.stderr.write("serving %s at http://127.0.0.1:%d/\n"
                     % (root, server.server_address[1]))
    for name in sorted(proxies):
        sys.stderr.write("  /proxy/%s/ -> %s\n" % (name, proxies[name]))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
