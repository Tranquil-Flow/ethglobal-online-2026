#!/usr/bin/env python3
"""Read-only source fingerprinting; no imports, runs, or copied Mycelium source."""
import hashlib,json,pathlib,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[1]
SOURCE=pathlib.Path('/Users/evinova-self/Documents/playground/mycelium-wave8-integration')
ANCHOR='abe291c3ae856bef60394f528f1f86bddf78b2ad'
FILES=['mycelium_request_gateway/backend.py','mycelium_request_gateway/contracts.py','mycelium_request_gateway/asgi.py','mycelium_request_gateway/client.py','mycelium_request_gateway/qualification.py','mycelium_request_gateway/service.py','mycelium_request_gateway/init.py','mycelium_live/codec.py','mycelium_live/router_port.py','mycelium_live/registry.py','mycelium_router/decoding.py','mycelium_router/entry.py']
def git(*args):return subprocess.check_output(['git','-C',str(SOURCE),*args])
rows=[]
for name in FILES:
    blob=git('show',ANCHOR+':'+name)
    current=(SOURCE/name).read_bytes()
    rows.append({'path':name,'sha256':hashlib.sha256(blob).hexdigest(),'current_file_matches_inspected_commit':current==blob})
root_names=git('ls-tree','--name-only',ANCHOR).decode().splitlines()
result={'version':1,'scope':'source-only; no runtime or physical verification','inspectedCommit':ANCHOR,'currentHead':git('rev-parse','HEAD').decode().strip(),'sourceFiles':rows,'rootLicenseNames':[x for x in root_names if x.lower().startswith(('license','copying','copyright'))]}
out=ROOT/'artifacts/closeout/goal-c-source-fingerprints.json';out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'evidence':str(out),'inspectedCommit':ANCHOR,'currentHead':result['currentHead'],'allInspectedFilesStillMatch':all(r['current_file_matches_inspected_commit'] for r in rows),'rootLicenseNames':result['rootLicenseNames']}))
