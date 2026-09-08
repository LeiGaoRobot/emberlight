import http.server, base64, json, os, sys
OUT = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin','*'); self.send_header('Access-Control-Allow-Headers','*'); self.send_header('Access-Control-Allow-Methods','POST,OPTIONS')
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def do_POST(self):
        n=int(self.headers['Content-Length']); d=json.loads(self.rfile.read(n))
        p=os.path.join(OUT,d['name']); open(p,'wb').write(base64.b64decode(d['data'].split(',',1)[1]))
        self.send_response(200); self._cors(); self.end_headers(); self.wfile.write(b'ok')
    def log_message(self,*a): pass
http.server.HTTPServer(('127.0.0.1',8201),H).serve_forever()
