"""Small-fixture CPU/RSS smoke measurement; not a production load claim."""
from pathlib import Path
import json
import os
import resource
import subprocess
import sys
import time
ROOT=Path(__file__).resolve().parents[1]
rows=[]
for name,kind in [('panduan-demo.pdf','PDF'),('multikolom-demo.pdf','PDF'),('panduan-demo.docx','DOCX'),('sla-demo.xlsx','XLSX')]:
 before=resource.getrusage(resource.RUSAGE_CHILDREN);start=time.perf_counter()
 run=subprocess.run([sys.executable,'-I',str(ROOT/'apps/knowledge-runtime/convert.py'),kind,str(ROOT/'fixtures/uploads'/name)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=25,env={'PATH':os.defpath,'LANG':'C.UTF-8','OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1'})
 elapsed=time.perf_counter()-start;after=resource.getrusage(resource.RUSAGE_CHILDREN)
 if run.returncode:raise RuntimeError('Conversion smoke failed: '+name)
 result=json.loads(run.stdout)
 rows.append({'fixture':name,'sourceBytes':(ROOT/'fixtures/uploads'/name).stat().st_size,'canonicalBytes':len(result['markdown'].encode()),'wallMs':round(elapsed*1000,2),'cpuMs':round(((after.ru_utime-before.ru_utime)+(after.ru_stime-before.ru_stime))*1000,2),'processRssHighWaterKiB':after.ru_maxrss,'locatorCount':len(result['mappings'])})
output={'python':sys.version.split()[0],'platform':sys.platform,'scope':'Single sequential synthetic fixtures, child CPU/time; ru_maxrss is high-water across children, not per-file isolated peak. Not a load/production benchmark.','results':rows}
(ROOT/'artifacts').mkdir(exist_ok=True)
(ROOT/'artifacts/converter-metrics.json').write_text(json.dumps(output,indent=2)+'\n')
print(json.dumps(output,indent=2))
