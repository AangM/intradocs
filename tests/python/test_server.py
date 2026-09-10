"""Authenticated converter HTTP contract with real subprocess parsing; local only."""
import http.client
import importlib.util
import hashlib
import json
import os
import threading
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
# Test-only synthetic token, not a service credential or bypass.
os.environ['KNOWLEDGE_TOKEN']='synthetic-test-token-000000000000000000000000'
spec=importlib.util.spec_from_file_location('server',ROOT/'apps/knowledge-runtime/server.py')
server=importlib.util.module_from_spec(spec);spec.loader.exec_module(server)
class ServerContract(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
  cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True);cls.thread.start()
 @classmethod
 def tearDownClass(cls):cls.http.shutdown();cls.http.server_close();cls.thread.join(timeout=2)
 def request(self,path='/health',method='GET',body=None,headers=None):
  c=http.client.HTTPConnection('127.0.0.1',self.http.server_port,timeout=30)
  try:
   c.request(method,path,body=body,headers=headers or {});r=c.getresponse();return r.status,r.read()
  finally:c.close()
 def test_health_requires_auth(self):
  self.assertEqual(self.request()[0],404)
  self.assertEqual(self.request(headers={'Authorization':'Bearer '+os.environ['KNOWLEDGE_TOKEN']})[0],200)
 def test_real_pdf_subprocess_and_hash_contract(self):
  data=(ROOT/'fixtures/uploads/panduan-demo.pdf').read_bytes()
  headers={'Authorization':'Bearer '+os.environ['KNOWLEDGE_TOKEN'],'Content-Type':'application/octet-stream','X-Source-Format':'PDF','X-Source-Sha256':hashlib.sha256(data).hexdigest()}
  status,body=self.request('/convert','POST',data,headers);self.assertEqual(status,200,body[:100]);result=json.loads(body);self.assertIn('99.90%',result['markdown'])
  headers['X-Source-Sha256']='0'*64
  self.assertEqual(self.request('/convert','POST',data,headers)[0],422)
 def test_unsigned_or_unsupported_payload_never_converts(self):
  self.assertEqual(self.request('/convert','POST',b'text')[0],404)
  self.assertIn(self.request('/convert','POST',b'text',{'Authorization':'Bearer '+os.environ['KNOWLEDGE_TOKEN']})[0],(400,415,422))
if __name__=='__main__':unittest.main()
