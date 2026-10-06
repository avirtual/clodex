import http.server, time
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/hang'):
            time.sleep(90)
        self.send_response(200); self.send_header('Content-Type','text/plain'); self.send_header('Access-Control-Allow-Origin','*'); self.end_headers(); self.wfile.write(b'ok')
    def log_message(self,*a): pass
http.server.ThreadingHTTPServer(('127.0.0.1',8732),H).serve_forever()
