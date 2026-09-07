"""Fetch pinned official ENSv2 deployment artifacts, never sibling code."""
import hashlib, json, pathlib, urllib.request
REV = '97a57293f3b4279d94b571e678edb53ce62638f4'
BASE = f'https://raw.githubusercontent.com/ensdomains/contracts-v2/{REV}/contracts/'
root = pathlib.Path(__file__).resolve().parents[1] / 'vendor'
root.mkdir(exist_ok=True)
manifest = {'repository': 'https://github.com/ensdomains/contracts-v2', 'revision': REV, 'docs': 'https://docs.ens.domains/learn/deployments/#sepolia-ensv2-beta', 'artifacts': {}}
for name in ['PermissionedResolverImpl', 'RootRegistry', 'UniversalResolverV2', 'VerifiableFactory', 'LabelStore']:
    url = BASE + 'deployments/sepolia/' + name + '.json'
    raw = urllib.request.urlopen(url, timeout=30).read()
    obj = json.loads(raw)
    kept = {k: obj[k] for k in ['abi', 'bytecode', 'address', 'sourceName', 'contractName']}
    content = (json.dumps(kept, indent=2) + '\n').encode()
    (root / (name+'.json')).write_bytes(content)
    manifest['artifacts'][name] = {'url': url, 'upstreamSHA256': hashlib.sha256(raw).hexdigest(), 'vendoredSHA256': hashlib.sha256(content).hexdigest(), 'address': obj['address'], 'licenses': sorted(set(v.get('license','unspecified') for v in json.loads(obj['metadata'])['sources'].values()))}
(root / 'provenance.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps(manifest, indent=2))
