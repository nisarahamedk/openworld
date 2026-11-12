# Sandbox A: a "ledger" service on port 18080 that answers with its own world time.
import http.server, json, time
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        time.sleep(0.05)  # a little real work
        b = json.dumps({"now": time.time()}).encode()
        self.send_response(200); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", 18080), H).serve_forever(poll_interval=3600)  # block like a real server, no polling
