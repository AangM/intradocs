import importlib.util
import io
import json
import unittest
import zipfile
from pathlib import Path
from openpyxl import Workbook
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('convert',ROOT/'apps/knowledge-runtime/convert.py')
converter=importlib.util.module_from_spec(spec);spec.loader.exec_module(converter)

class ConversionTests(unittest.TestCase):
 def read(self,name):return (ROOT/'fixtures/uploads'/name).read_bytes()
 def convert(self,name,kind):return converter.convert(self.read(name),kind)
 def test_pdf_pages_and_numbers(self):
  result=self.convert('panduan-demo.pdf','PDF')
  self.assertIn('99.90%',result['markdown']);self.assertIn('15 menit',result['markdown'])
  self.assertEqual([m['locator'] for m in result['mappings']],['Halaman 1','Halaman 2'])
 def test_pdf_multicolumn_is_literal_with_layout(self):
  text=self.convert('multikolom-demo.pdf','PDF')['markdown']
  self.assertIn('128 Mbps',text);self.assertIn('64 Mbps',text);self.assertIn('```text',text)
 def test_docx_numbering_table_and_unicode(self):
  result=self.convert('panduan-demo.docx','DOCX');text=result['markdown']
  for expected in ['1. Verifikasi','2. Cadangkan','3. Uji','99,90%','15 menit','日本語']:self.assertIn(expected,text)
  self.assertFalse(any('Halaman' in m['locator'] for m in result['mappings']))
 def test_xlsx_cells_numbers_and_source_format(self):
  result=self.convert('sla-demo.xlsx','XLSX');text=result['markdown']
  for expected in ['99.9','15','A2: VPN demo','B2:','C3: 30','format sumber: 0.00']:self.assertIn(expected,text)
  self.assertTrue(any('A2:C2' in m['locator'] for m in result['mappings']))
 def test_canonical_is_deterministic(self):
  for name,kind in [('panduan-demo.pdf','PDF'),('panduan-demo.docx','DOCX'),('sla-demo.xlsx','XLSX')]:self.assertEqual(self.convert(name,kind),self.convert(name,kind))
 def test_rejected_inputs_are_not_empty_successes(self):
  for name,kind,code in [('encrypted-demo.pdf','PDF','encrypted'),('scanned-empty-demo.pdf','PDF','empty_text'),('corrupt-demo.pdf','PDF','invalid_file'),('hostile-office.docx','DOCX','unsafe_archive'),('formula-no-cache.xlsx','XLSX','missing_cached_value')]:
   with self.subTest(name=name):
    with self.assertRaises(converter.ConversionError) as caught:self.convert(name,kind)
    self.assertEqual(caught.exception.code,code)
 def test_empty_workbook_rejected(self):
  stream=io.BytesIO();Workbook().save(stream)
  with self.assertRaises(converter.ConversionError) as e:converter.convert(stream.getvalue(),'XLSX')
  self.assertEqual(e.exception.code,'empty_text')
 def test_xxe_and_macro_rejected(self):
  for body,member in [('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x>&x;</x>','word/document.xml'),('<x/>','word/vbaProject.bin')]:
   b=io.BytesIO()
   with zipfile.ZipFile(b,'w') as z:z.writestr('[Content_Types].xml','<Types/>');z.writestr(member,body)
   with self.assertRaises(converter.ConversionError):converter.convert(b.getvalue(),'DOCX')
 def test_manifest_hash_and_line_ranges(self):
  import hashlib
  for name,kind in [('panduan-demo.pdf','PDF'),('panduan-demo.docx','DOCX'),('sla-demo.xlsx','XLSX')]:
   result=self.convert(name,kind)
   self.assertEqual(result['sourceHash'],hashlib.sha256(self.read(name)).hexdigest())
   self.assertEqual(result['markdownHash'],hashlib.sha256(result['markdown'].encode()).hexdigest())
   lines=result['markdown'].split('\n')
   for m in result['mappings']:self.assertTrue(1<=m['markdownStart']<=m['markdownEnd']<=len(lines))

if __name__=='__main__':unittest.main()
