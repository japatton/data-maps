import email
import http.client
import io
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import HTTPServer
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tools"))

import studio_dev


class FakeResponse(object):
    def __init__(self, status, headers, body):
        self.status = status
        self._headers = headers
        self._body = body
        self.closed = False

    def getheaders(self):
        return self._headers

    def read(self):
        return self._body

    def close(self):
        self.closed = True


def start(server):
    """Serve on a daemon thread; the short poll keeps shutdown() quick."""
    threading.Thread(target=server.serve_forever,
                     kwargs={"poll_interval": 0.05}, daemon=True).start()
    return server.server_address[1]


class TempDirMixin(object):
    def tmpdir(self):
        """A temporary directory removed when the test ends."""
        path = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, path, ignore_errors=True)
        return path


class TestDevServer(TempDirMixin, unittest.TestCase):
    def setUp(self):
        self.root = self.tmpdir()
        with open(os.path.join(self.root, "index.html"), "w") as fh:
            fh.write("<p>hi</p>")
        self.seen = []

        def opener(req):
            self.seen.append(req)
            return 201, [("Content-Type", "application/json")], b'{"ok":1}'

        handler = studio_dev.build_handler(
            self.root, {"f": "https://up/api/v1"}, opener)
        self.server = HTTPServer(("127.0.0.1", 0), handler)
        self.port = start(self.server)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def req(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            resp = conn.getresponse()
            return resp.status, dict(resp.getheaders()), resp.read()
        finally:
            conn.close()

    def test_static(self):
        status, _, body = self.req("GET", "/index.html")
        self.assertEqual((status, body), (200, b"<p>hi</p>"))

    def test_static_index_at_root(self):
        status, _, body = self.req("GET", "/")
        self.assertEqual((status, body), (200, b"<p>hi</p>"))

    def test_no_store_on_static(self):
        _, headers, _ = self.req("GET", "/index.html")
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_no_store_on_proxy(self):
        _, headers, _ = self.req("GET", "/proxy/f/repos/x")
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_preflight(self):
        status, headers, _ = self.req("OPTIONS", "/proxy/f/repos/x")
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        self.assertIn("PRIVATE-TOKEN", headers["Access-Control-Allow-Headers"])
        self.assertEqual(self.seen, [])

    def test_preflight_sends_no_content_length(self):
        """A 204 must not declare a length for the body it cannot have."""
        _, headers, body = self.req("OPTIONS", "/proxy/f/repos/x")
        self.assertNotIn("Content-Length", headers)
        self.assertEqual(body, b"")

    def test_empty_post_body_declares_zero_length(self):
        """Upstreams that insist on a length answer 411 without one."""
        status, _, _ = self.req("POST", "/proxy/f/it")
        self.assertEqual(status, 201)
        req = self.seen[0]
        self.assertEqual(req.data, b"")
        self.assertEqual(req.get_header("Content-length"), "0")

    def test_empty_delete_body_gets_no_length(self):
        self.req("DELETE", "/proxy/f/it")
        req = self.seen[0]
        self.assertIsNone(req.data)
        self.assertIsNone(req.get_header("Content-length"))

    def test_proxy_name_without_trailing_slash(self):
        status, _, _ = self.req("GET", "/proxy/f?ref=b")
        self.assertEqual(status, 201)
        self.assertEqual(self.seen[0].get_full_url(),
                         "https://up/api/v1/?ref=b")

    def test_bare_proxy_name_hits_the_target_root(self):
        status, _, _ = self.req("GET", "/proxy/f")
        self.assertEqual(status, 201)
        self.assertEqual(self.seen[0].get_full_url(), "https://up/api/v1/")

    def test_forward(self):
        status, headers, body = self.req(
            "POST", "/proxy/f/repos/x/contents?ref=b", body=b'{"a":1}',
            headers={"Authorization": "token T", "Content-Type": "application/json"})
        self.assertEqual(status, 201)
        self.assertEqual(json.loads(body.decode()), {"ok": 1})
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        req = self.seen[0]
        self.assertEqual(req.get_full_url(), "https://up/api/v1/repos/x/contents?ref=b")
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(req.data, b'{"a":1}')
        self.assertEqual(req.get_header("Authorization"), "token T")

    def test_forward_private_token_and_put(self):
        self.req("PUT", "/proxy/f/it", body=b"x",
                 headers={"PRIVATE-TOKEN": "abc"})
        req = self.seen[0]
        self.assertEqual(req.get_method(), "PUT")
        self.assertEqual(req.get_header("Private-token"), "abc")

    def test_delete_forwards(self):
        status, _, _ = self.req("DELETE", "/proxy/f/it")
        self.assertEqual(status, 201)
        self.assertEqual(self.seen[0].get_method(), "DELETE")

    def test_head_on_proxy_has_no_body(self):
        status, headers, body = self.req("HEAD", "/proxy/f/it")
        self.assertEqual(status, 201)
        self.assertEqual(body, b"")
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")

    def test_unknown_proxy_404(self):
        status, _, _ = self.req("GET", "/proxy/nope/x")
        self.assertEqual(status, 404)


class TestStudioOverlay(TempDirMixin, unittest.TestCase):
    def serve(self, handler):
        server = HTTPServer(("127.0.0.1", 0), handler)
        port = start(server)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return port

    def get(self, port, path):
        conn = http.client.HTTPConnection("127.0.0.1", port)
        try:
            conn.request("GET", path)
            resp = conn.getresponse()
            return resp.status, resp.read()
        finally:
            conn.close()

    def test_overlay_serves_source_when_present(self):
        root = self.tmpdir()
        src = self.tmpdir()
        os.makedirs(os.path.join(root, "studio"))
        with open(os.path.join(root, "studio", "a.js"), "w") as fh:
            fh.write("built")
        with open(os.path.join(root, "studio", "schema.json"), "w") as fh:
            fh.write("{}")
        with open(os.path.join(src, "a.js"), "w") as fh:
            fh.write("live")
        port = self.serve(studio_dev.build_handler(
            root, {}, lambda r: (500, [], b""), studio_src=src))
        # The overlay wins for a.js; schema.json exists only in the build.
        for path, expected in (("/studio/a.js", b"live"),
                               ("/studio/schema.json", b"{}")):
            self.assertEqual(self.get(port, path), (200, expected), path)

    def test_overlay_serves_index_for_studio_directory(self):
        root = self.tmpdir()
        src = self.tmpdir()
        os.makedirs(os.path.join(root, "studio"))
        with open(os.path.join(root, "studio", "index.html"), "w") as fh:
            fh.write("built")
        with open(os.path.join(src, "index.html"), "w") as fh:
            fh.write("live")
        port = self.serve(studio_dev.build_handler(
            root, {}, lambda r: (500, [], b""), studio_src=src))
        self.assertEqual(self.get(port, "/studio/"), (200, b"live"))

    def test_overlay_ignores_traversal(self):
        # The decoy sits exactly one level above the source dir, so an
        # unfiltered join of "../secret.txt" would resolve onto it.
        root = self.tmpdir()
        outer = self.tmpdir()
        src = os.path.join(outer, "src")
        os.makedirs(src)
        os.makedirs(os.path.join(root, "studio"))
        with open(os.path.join(root, "studio", "a.js"), "w") as fh:
            fh.write("built")
        with open(os.path.join(outer, "secret.txt"), "w") as fh:
            fh.write("SECRET")
        port = self.serve(studio_dev.build_handler(
            root, {}, lambda r: (500, [], b""), studio_src=src))
        for path in ("/studio/../secret.txt", "/studio/..%2Fsecret.txt"):
            status, body = self.get(port, path)
            self.assertEqual(status, 404, path)
            self.assertNotIn(b"SECRET", body, path)

    def test_overlay_decodes_percent_escapes(self):
        root = self.tmpdir()
        src = self.tmpdir()
        os.makedirs(os.path.join(root, "studio"))
        with open(os.path.join(src, "a b.js"), "w") as fh:
            fh.write("live")
        port = self.serve(studio_dev.build_handler(
            root, {}, lambda r: (500, [], b""), studio_src=src))
        self.assertEqual(self.get(port, "/studio/a%20b.js"), (200, b"live"))

    def test_serves_root_when_no_studio_src(self):
        root = self.tmpdir()
        os.makedirs(os.path.join(root, "studio"))
        with open(os.path.join(root, "studio", "a.js"), "w") as fh:
            fh.write("built")
        port = self.serve(studio_dev.build_handler(
            root, {}, lambda r: (500, [], b"")))
        self.assertEqual(self.get(port, "/studio/a.js"), (200, b"built"))


class TestDefaultOpener(unittest.TestCase):
    def test_returns_status_headers_body(self):
        resp = FakeResponse(200, [("Content-Type", "application/json")], b"{}")
        with mock.patch("urllib.request.urlopen", return_value=resp):
            self.assertEqual(
                studio_dev.default_opener(urllib.request.Request("http://x/")),
                (200, [("Content-Type", "application/json")], b"{}"))
        self.assertTrue(resp.closed)

    def test_http_error_is_relayed(self):
        err = urllib.error.HTTPError(
            "http://x/", 404, "Not Found",
            email.message_from_string("Content-Type: text/plain"),
            io.BytesIO(b"nope"))
        with mock.patch("urllib.request.urlopen", side_effect=err):
            status, headers, body = studio_dev.default_opener(
                urllib.request.Request("http://x/"))
        self.assertEqual((status, body), (404, b"nope"))
        self.assertEqual(headers, [("Content-Type", "text/plain")])


class TestUnreachableUpstream(TempDirMixin, unittest.TestCase):
    """An upstream that cannot be reached must still get an HTTP answer."""

    def serve(self, opener):
        handler = studio_dev.build_handler(
            self.tmpdir(), {"f": "https://up/api/v1"}, opener)
        server = HTTPServer(("127.0.0.1", 0), handler)
        port = start(server)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return port

    def get(self, port, path):
        conn = http.client.HTTPConnection("127.0.0.1", port)
        try:
            conn.request("GET", path)
            resp = conn.getresponse()
            return resp.status, dict(resp.getheaders()), resp.read()
        finally:
            conn.close()

    def raising(self, exc):
        def opener(req):
            raise exc
        return opener

    def test_url_error_becomes_502_with_cors(self):
        port = self.serve(self.raising(
            urllib.error.URLError(ConnectionRefusedError(61, "Connection refused"))))
        status, headers, body = self.get(port, "/proxy/f/repos/x")
        self.assertEqual(status, 502)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        self.assertIn(b"proxy error", body)
        self.assertIn(b"Connection refused", body)

    def test_timeout_becomes_502(self):
        port = self.serve(self.raising(socket.timeout("timed out")))
        status, headers, body = self.get(port, "/proxy/f/repos/x")
        self.assertEqual(status, 502)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        self.assertIn(b"proxy error", body)

    def test_default_opener_url_error_becomes_502(self):
        err = urllib.error.URLError("[SSL] handshake failure")
        with mock.patch("urllib.request.urlopen", side_effect=err):
            status, headers, body = studio_dev.default_opener(
                urllib.request.Request("https://up/api/v1/x"))
        self.assertEqual(status, 502)
        self.assertEqual(headers, [("Content-Type", "text/plain; charset=utf-8")])
        self.assertIn(b"https://up/api/v1/x", body)
        self.assertIn(b"handshake failure", body)

    def test_default_opener_timeout_becomes_502(self):
        with mock.patch("urllib.request.urlopen", side_effect=socket.timeout("timed out")):
            status, _, body = studio_dev.default_opener(
                urllib.request.Request("https://up/api/v1/x"))
        self.assertEqual(status, 502)
        self.assertIn(b"timed out", body)


class TestParseProxies(unittest.TestCase):
    def test_parses_name_value_pairs(self):
        self.assertEqual(
            studio_dev.parse_proxies(["f=https://up/api/v1", "es=http://e:9200"]),
            {"f": "https://up/api/v1", "es": "http://e:9200"})

    def test_rejects_missing_equals(self):
        with self.assertRaises(ValueError):
            studio_dev.parse_proxies(["nope"])


if __name__ == "__main__":
    unittest.main()
