#!/usr/bin/env python3
"""Simple path-based reverse proxy for Tailscale Serve.
Routes: /study/* → localhost:8788, everything else → localhost:8787 (WebUI)"""
import http.server
import urllib.request
import urllib.error
from pathlib import Path

PORT = 8789
STUDY_UPSTREAM = "http://127.0.0.1:8788"
WEBUI_UPSTREAM = "http://127.0.0.1:8787"

class Proxy(http.server.BaseHTTPRequestHandler):
    def do_request(self, method):
        if self.path.startswith("/study"):
            target = STUDY_UPSTREAM
            # Strip /study prefix for the study-hub server
            upstream_path = self.path[6:] or "/"
        else:
            target = WEBUI_UPSTREAM
            upstream_path = self.path

        url = f"{target}{upstream_path}"
        try:
            data = None
            if method in ("POST", "PUT", "PATCH"):
                length = int(self.headers.get("Content-Length", 0))
                data = self.rfile.read(length)

            req = urllib.request.Request(url, data=data, method=method)
            # Forward select headers
            for h in ("Content-Type", "Authorization", "Accept", "Cookie"):
                if h in self.headers:
                    req.add_header(h, self.headers[h])

            with urllib.request.urlopen(req, timeout=30) as resp:
                self.send_response(resp.status)
                for k, v in resp.getheaders():
                    if k.lower() not in ("transfer-encoding", "connection", "keep-alive"):
                        self.send_header(k, v)
                self.end_headers()
                body = resp.read()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.end_headers()
            body = e.read()
            self.wfile.write(body)
        except Exception as e:
            self.send_response(502)
            self.end_headers()
            self.wfile.write(f"Proxy error: {e}".encode())

    do_GET = lambda s: s.do_request("GET")
    do_POST = lambda s: s.do_request("POST")
    do_PUT = lambda s: s.do_request("PUT")
    do_HEAD = lambda s: s.do_request("HEAD")

    def log_message(self, format, *args):
        pass  # Silence logs

if __name__ == "__main__":
    httpd = http.server.HTTPServer(("127.0.0.1", PORT), Proxy)
    print(f"Proxy on :{PORT} → /study/ → {STUDY_UPSTREAM}, / → {WEBUI_UPSTREAM}")
    httpd.serve_forever()
