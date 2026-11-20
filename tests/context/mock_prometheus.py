"""Local-only Prometheus mock: records every received header for context verification."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

LOG = os.environ.get('HEADER_LOG', '/evidence/upstream-headers.jsonl')

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        path = urlsplit(self.path).path
        record = {'method': self.command, 'path': self.path,
                  'headers': {key: self.headers.get_all(key) for key in self.headers.keys()}}
        with open(LOG, 'a') as out:
            out.write(json.dumps(record) + '\n')
        if path.endswith('/query_range'):
            data = {'resultType': 'matrix', 'result': [{'metric': {'__name__': 'up', 'job': 'context-mock'},
                                                     'values': [[1700000040, '1']]}]}
        elif path.endswith('/query'):
            data = {'resultType': 'vector', 'result': []}
        elif path.endswith('/labels'):
            data = ['__name__', 'job', 'pod']
        elif path.endswith('/values'):
            data = ['up']
        elif path.endswith('/metadata'):
            data = {'up': [{'type': 'gauge', 'help': 'Context mock', 'unit': ''}]}
        else:
            data = []
        payload = json.dumps({'status': 'success', 'data': data}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

ThreadingHTTPServer(('0.0.0.0', 9091), Handler).serve_forever()
