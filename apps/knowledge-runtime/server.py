"""Loopback/internal conversion gateway. Each parse runs with bounded CPU/RAM/time.
No DB/storage/provider credentials enter the parser. Container network has no egress.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import tempfile
import threading

LIMIT = 50 * 1024 * 1024
TOKEN = os.environ.get('KNOWLEDGE_TOKEN', '')
if not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', TOKEN):
    raise RuntimeError('KNOWLEDGE_TOKEN must be generated before starting the converter')
SLOTS = threading.BoundedSemaphore(1)
ROOT = Path(__file__).resolve().parent

class Handler(BaseHTTPRequestHandler):
    server_version = 'IntraDocsConverter/2'

    def log_message(self, *_args):
        pass  # Never log source names, contents or authorization headers.

    def setup(self):
        super().setup()
        self.connection.settimeout(20)

    def send_json(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def authorized(self):
        return hmac.compare_digest(self.headers.get('Authorization', '').encode('utf-8'), ('Bearer ' + TOKEN).encode('utf-8'))

    def do_GET(self):
        if self.path != '/health' or not self.authorized():
            self.send_json(404, {'code': 'unavailable'})
            return
        self.send_json(200, {'status': 'ok', 'pipeline': 'canonical-v2', 'formats': ['PDF', 'DOCX', 'XLSX']})

    def do_POST(self):
        if self.path != '/convert' or not self.authorized():
            self.send_json(404, {'code': 'unavailable'})
            return
        raw_length = self.headers.get_all('Content-Length', [])
        kind = self.headers.get('X-Source-Format', '')
        checksum = self.headers.get('X-Source-Sha256', '')
        if (len(raw_length) != 1 or not re.fullmatch(r'[0-9]{1,10}', raw_length[0]) or self.headers.get('Transfer-Encoding')
            or not 0 < int(raw_length[0]) <= LIMIT or kind not in ('PDF', 'DOCX', 'XLSX')
            or not re.fullmatch(r'[a-f0-9]{64}', checksum)
            or self.headers.get('Content-Type') != 'application/octet-stream'):
            self.send_json(400, {'code': 'invalid_file'})
            return
        if not SLOTS.acquire(blocking=False):
            self.send_json(503, {'code': 'busy'})
            return
        status, response = 422, {'code': 'invalid_file'}
        try:
            with tempfile.TemporaryDirectory(prefix='convert-') as directory:
                source = Path(directory) / 'source'
                remaining = int(raw_length[0])
                hasher = hashlib.sha256()
                with source.open('xb') as stream:
                    while remaining:
                        block = self.rfile.read(min(65536, remaining))
                        if not block:
                            raise ValueError('Truncated body')
                        stream.write(block)
                        hasher.update(block)
                        remaining -= len(block)
                if not hmac.compare_digest(hasher.hexdigest(), checksum):
                    raise ValueError('Checksum mismatch')
                output = Path(directory) / 'result.json'
                with output.open('wb') as stream:
                    result = subprocess.run([sys.executable, '-I', str(ROOT / 'convert.py'), kind, str(source)],
                        cwd=directory, env={'LANG': 'C.UTF-8', 'PATH': os.defpath,
                            'OPENBLAS_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1'}, stdout=stream,
                        stderr=subprocess.DEVNULL, timeout=25, check=False)
                if output.stat().st_size > 5 * 1024 * 1024:
                    status, response = 422, {'code': 'complexity'}
                else:
                    response = json.loads(output.read_bytes())
                    status = 200 if result.returncode == 0 else 422
        except subprocess.TimeoutExpired:
            status, response = 422, {'code': 'complexity'}
        except (OSError, ValueError):
            status, response = 422, {'code': 'invalid_file'}
        finally:
            # Free the parse slot before sending the response. A sequential
            # attachment request must not race a previous response's finally.
            SLOTS.release()
        self.send_json(status, response)

if __name__ == '__main__':
    # Internal container port is exposed to host loopback by Compose only.
    server = ThreadingHTTPServer((os.environ.get('KNOWLEDGE_BIND', '127.0.0.1'), 8091), Handler)
    server.daemon_threads = True
    print('IntraDocs converter ready; no external providers', flush=True)
    server.serve_forever()
