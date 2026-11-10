"""make preview: static server like `python -m http.server`, but with
Cache-Control: no-store, so the browser never mixes a new index.html with
cached old js/css after `git pull` / `git checkout` (seen in testing: the new
Map tab button showed up while the cached app.js still said v1.12.0)."""
import functools
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    handler = functools.partial(NoCacheHandler, directory='.')
    with http.server.ThreadingHTTPServer(('127.0.0.1', port), handler) as srv:
        srv.serve_forever()
