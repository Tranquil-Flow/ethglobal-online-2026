#!/usr/bin/env python3
"""Fixed Wave 5 laptop runtime. No research checkout or global service changes."""
import datetime
import hashlib
import json
import os
import pathlib
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

HOST = '100.126.111.123'
MODEL = 'qwen2.5:7b'
VERSION = '0.20.0'
ARCHIVE_URL = 'https://github.com/ollama/ollama/releases/download/v0.20.0/ollama-darwin.tgz'
ARCHIVE_BYTES = 76648383
ARCHIVE_SHA256 = '00c05b2b93802277f5925dd8bb63dd0d3090758e297c1f8b9a7944b2856dc884'
HOME = pathlib.Path.home()
ROOT = HOME / '.private/wave5'
os.umask(0o077)

def fail(code):
    raise RuntimeError(code)

def save(name, data):
    dest = ROOT / name
    temp = dest.with_name(dest.name + '.tmp')
    with temp.open('x') as out:
        json.dump(data, out, indent=2); out.write('\n')
    temp.replace(dest)

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1048576), b''): h.update(block)
    return h.hexdigest()

def api(path):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://' + HOST + ':11434' + path, timeout=5) as r:
        return json.load(r)

def listening():
    try:
        with socket.create_connection((HOST, 11434), timeout=1): return True
    except OSError: return False

def binary():
    d = json.loads((ROOT / 'ollama-install.json').read_text())
    path = pathlib.Path(d['binary'])
    if not path.is_file() or digest(path) != d['binarySha256']: fail('INSTALLED_BINARY_MISMATCH')
    return path

def env():
    value = os.environ.copy()
    value.update(OLLAMA_HOST=HOST + ':11434', OLLAMA_MODELS=str(ROOT / 'ollama-models'), OLLAMA_MAX_LOADED_MODELS='1', OLLAMA_NUM_PARALLEL='1', OLLAMA_KEEP_ALIVE='0', OLLAMA_NO_CLOUD='1')
    return value

def inspect():
    state = {'hostname': socket.gethostname(), 'nodeId': 'evis-macbook-pro-1', 'sshConnection': os.environ.get('SSH_CONNECTION'), 'architecture': subprocess.check_output(['uname','-m'], text=True).strip(), 'memoryBytes': int(subprocess.check_output(['/usr/sbin/sysctl','-n','hw.memsize'], text=True)), 'freeDiskBytes': shutil.disk_usage(ROOT).free, 'listening': listening()}
    if state['listening']:
        state.update(version=api('/api/version'), models=api('/api/tags'), running=api('/api/ps'))
    return state

def install():
    marker = ROOT / 'ollama-install.json'
    if marker.exists():
        path = binary(); return {'status':'already-installed','binary':str(path),'version':VERSION}
    if shutil.disk_usage(ROOT).free < 9 * 1024**3: fail('INSUFFICIENT_DISK_FOR_MODEL_AND_RESERVE')
    archive = ROOT / 'ollama-darwin-0.20.0.tgz'
    if not archive.exists():
        part = archive.with_suffix('.part')
        with urllib.request.urlopen(ARCHIVE_URL, timeout=30) as response, part.open('xb') as output:
            total = 0
            while True:
                chunk = response.read(1048576)
                if not chunk: break
                total += len(chunk)
                if total > ARCHIVE_BYTES: fail('ARCHIVE_SIZE_MISMATCH')
                output.write(chunk)
        part.replace(archive)
    if archive.stat().st_size != ARCHIVE_BYTES or digest(archive) != ARCHIVE_SHA256: fail('ARCHIVE_DIGEST_MISMATCH')
    target = ROOT / ('ollama-' + VERSION)
    if target.exists(): fail('UNOWNED_INSTALL_DESTINATION')
    stage = pathlib.Path(tempfile.mkdtemp(prefix='ollama-install-', dir=str(ROOT)))
    try:
        with tarfile.open(archive, 'r:gz') as tar:
            members = tar.getmembers()
            if len(members) > 3000 or sum(m.size for m in members) > 1024**3: fail('ARCHIVE_BOUNDS')
            for m in members:
                p = pathlib.PurePosixPath(m.name)
                if p.is_absolute() or '..' in p.parts or not (m.isfile() or m.isdir() or m.issym() or m.islnk()): fail('UNSAFE_ARCHIVE_MEMBER')
                if m.issym() or m.islnk():
                    link = pathlib.PurePosixPath(m.linkname)
                    if link.is_absolute() or '..' in link.parts: fail('UNSAFE_ARCHIVE_LINK')
            tar.extractall(str(stage), members=members)
        candidates = [p for p in stage.rglob('ollama') if p.is_file() and os.access(p, os.X_OK)]
        if len(candidates) != 1: fail('OLLAMA_EXECUTABLE_NOT_UNIQUE')
        relative = candidates[0].relative_to(stage)
        stage.rename(target)
        path = target / relative
        link = HOME / '.cargo/bin/ollama'
        if not link.parent.is_dir() or link.parent.is_symlink(): fail('USER_PATH_LINK_UNAVAILABLE')
        if link.exists() or link.is_symlink(): fail('EXISTING_PATH_ENTRY_PRESERVED')
        link.symlink_to(path)
        result = {'status':'installed','version':VERSION,'archiveUrl':ARCHIVE_URL,'archiveSha256':ARCHIVE_SHA256,'archiveBytes':ARCHIVE_BYTES,'binary':str(path),'binarySha256':digest(path),'pathLink':str(link),'installedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
        save('ollama-install.json', result)
        return result
    finally:
        if stage.exists(): shutil.rmtree(stage)

def serve():
    path = binary()
    if listening(): fail('EXISTING_LISTENER_PRESERVED')
    child = None; keepawake = None
    stop = False
    def terminate(_sig, _frame):
        nonlocal stop
        stop = True
    for sig in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]: signal.signal(sig, terminate)
    with (ROOT/'ollama-server.log').open('ab') as log:
        try:
            child = subprocess.Popen([str(path),'serve'], env=env(), stdout=log, stderr=subprocess.STDOUT)
            keepawake = subprocess.Popen(['/usr/bin/caffeinate','-i','-w',str(child.pid)])
            started = time.monotonic()
            while not listening():
                if child.poll() is not None or stop or time.monotonic()-started > 30: fail('OLLAMA_START_FAILED')
                time.sleep(.2)
            if api('/api/version').get('version') != VERSION: fail('OLLAMA_VERSION_MISMATCH')
            state = {'status':'serving','controllerPid':os.getpid(),'childPid':child.pid,'binary':str(path),'host':HOST,'port':11434,'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'maximumLifetimeSeconds':3600}
            save('ollama-server-state.json',state)
            print(json.dumps(state),flush=True)
            while child.poll() is None and not stop and time.monotonic()-started < 3600: time.sleep(.5)
        finally:
            if child and child.poll() is None:
                child.terminate()
                try: child.wait(timeout=10)
                except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=5)
            if keepawake and keepawake.poll() is None: keepawake.terminate(); keepawake.wait(timeout=5)
            result = {'status':'stopped','listenerAbsent':not listening(),'stoppedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
            save('ollama-server-stopped.json', result)
            print(json.dumps(result),flush=True)

def pull():
    path = binary()
    if not listening() or api('/api/version').get('version') != VERSION: fail('OWNED_OLLAMA_NOT_READY')
    with (ROOT/'ollama-pull.log').open('ab') as log:
        result = subprocess.run([str(path),'pull',MODEL],env=env(),stdout=log,stderr=subprocess.STDOUT,timeout=1800)
    if result.returncode: fail('OLLAMA_PULL_FAILED')
    models = api('/api/tags')['models']
    matches = [x for x in models if x['name'] == MODEL]
    if len(matches) != 1: fail('MODEL_NOT_PRESENT_AFTER_PULL')
    value = {'status':'pulled','model':matches[0],'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    save('model-assets.json',value); return value

def stop_server():
    state = json.loads((ROOT/'ollama-server-state.json').read_text())
    pid = state['controllerPid']
    command = subprocess.check_output(['ps','-p',str(pid),'-o','command='],text=True).strip()
    expected = str(ROOT/'ollama-node-bootstrap.py') + ' serve'
    if expected not in command: fail('CONTROLLER_IDENTITY_MISMATCH')
    os.kill(pid,signal.SIGTERM)
    end=time.monotonic()+15
    while listening() and time.monotonic()<end: time.sleep(.2)
    if listening(): fail('REMOTE_CLEANUP_UNCONFIRMED')
    return {'status':'stopped','listenerAbsent':True}

if __name__ == '__main__':
    try:
        if os.environ.get('SSH_CONNECTION','').split()[-2:] != [HOST,'22']: fail('WRONG_SSH_TARGET')
        if ROOT.is_symlink() or not ROOT.is_dir(): fail('PRIVATE_ROOT_REQUIRED')
        action = sys.argv[1] if len(sys.argv)==2 else ''
        if action not in ['install','serve','pull','inspect','stop']: fail('FIXED_WAVE5_SCOPE')
        result = {'install':install,'serve':serve,'pull':pull,'inspect':inspect,'stop':stop_server}[action]()
        if result is not None: print(json.dumps(result),flush=True)
    except Exception as error:
        code = str(error) if isinstance(error,RuntimeError) else type(error).__name__
        print(json.dumps({'status':'failed','code':code}),file=sys.stderr,flush=True)
        sys.exit(1)
