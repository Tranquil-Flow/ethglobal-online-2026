"""Private stdio worker owned by the application; no sockets or research state."""
import contextlib
import json
import os
import queue
import shutil
import signal
import sys
import threading
import traceback
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from backend import FixtureBackend,MlxVlmTextBackend,Cancelled
PROTOCOL='mycelium.application-native.v1'
MAX_LINE=262144
output_lock=threading.Lock()
active_lock=threading.Lock()
active=None
stopping=threading.Event()
backend=None
instance=None
profile=None
temporary=None

def safe_diagnostic(exc):
    # Never include exception messages, source lines, arguments or local paths.
    frames=traceback.extract_tb(exc.__traceback__)[-8:]
    return {'exceptionType':type(exc).__name__,'frames':[{'file':Path(x.filename).name,'function':x.name,'line':x.lineno} for x in frames],'weightsLoadCompleted':bool(getattr(backend,'weights_loaded',False))}

def emit(value):
    message={'protocol':PROTOCOL,'instanceId':instance,'profileId':profile,**value}
    data=json.dumps(message,ensure_ascii=False,allow_nan=False,separators=(',',':'))
    if len(data.encode())>MAX_LINE:raise ValueError('WORKER_EVENT_LIMIT')
    with output_lock:
        sys.__stdout__.write(data+'\n');sys.__stdout__.flush()

def request(value,limits):
    fields={'version','nonce','providerId','profileId','prompt','maxOutputTokens','seed','sampling','publishConsent'}
    if not isinstance(value,dict) or set(value)!=fields or value['profileId']!=profile or value['version']!='1' or value['seed']!=0 or value['sampling']!='greedy':raise ValueError('INVALID_NATIVE_REQUEST')
    prompt=value['prompt']
    if not isinstance(prompt,str) or len(prompt)>256 or len(prompt.encode('utf-8',errors='strict'))>1024 or type(value['maxOutputTokens']) is not int or not 1<=value['maxOutputTokens']<=limits['maxOutputTokens']:raise ValueError('NATIVE_REQUEST_BOUNDS')
    return value

def release_job(job):
    global active
    with active_lock:
        if active and active[0] == job:active=None

def generate(message,limits,cancelled):
    global active
    job=message['jobId']
    try:
        r=request(message['request'],limits)
        emit({'type':'accepted','jobId':job,'requestDigest':message['requestDigest']})
        with contextlib.redirect_stdout(sys.stderr):
            for event in backend.generate(r,cancelled):
                if cancelled.is_set():raise Cancelled()
                if event['type']=='completed':release_job(job)
                emit({'jobId':job,**event})
    except Cancelled:
        try:
            backend.cleanup()
            release_job(job)
            emit({'type':'cancelled','jobId':job,'cleanup':'confirmed'})
        except Exception:
            emit({'type':'failed','jobId':job,'code':'CANCELLATION_CLEANUP_UNCONFIRMED'})
    except Exception as exc:
        allowed={'INPUT_TOKEN_LIMIT','NATIVE_REQUEST_BOUNDS','INVALID_NATIVE_REQUEST','MLX_MEMORY_LIMIT','INVALID_NATIVE_TOKEN','NATIVE_TOKEN_SEQUENCE','OUTPUT_TOKEN_LIMIT','MISSING_NATIVE_TERMINAL'}
        code=str(exc) if isinstance(exc,ValueError) and str(exc) in allowed else 'NATIVE_EXECUTION_FAILED'
        release_job(job)
        emit({'type':'failed','jobId':job,'code':code,'diagnostic':safe_diagnostic(exc)})
    finally:
        release_job(job)

def stop(*_):
    stopping.set()
    with active_lock:
        if active:active[1].set()

def cleanup_temporary():
    if temporary is not None:
        try:
            if not temporary.is_symlink() and (temporary/'.owner').read_text()==instance:shutil.rmtree(temporary)
        except Exception:pass

def main():
    global instance,profile,backend,active,temporary
    line=sys.stdin.buffer.readline(MAX_LINE+1)
    if len(line)>MAX_LINE:raise ValueError('WORKER_INPUT_LIMIT')
    boot=json.loads(line);configuration=boot['configuration'];limits=boot['limits'];instance=boot['instanceId'];profile=configuration['profileId']
    if boot.get('op')!='boot':raise ValueError('BOOT_REQUIRED')
    candidate=Path(boot['temporaryDirectory'])
    if candidate.is_symlink() or not candidate.name.startswith('mycelium-app-native-') or candidate!=Path(os.environ['HOME']).parent or candidate!=Path(os.environ['TMPDIR']).parent or (candidate/'.owner').read_text()!=instance:raise ValueError('INVALID_WORKER_TEMPORARY_DIRECTORY')
    temporary=candidate
    engine=configuration['engine']
    if engine=='fixture' and configuration['mode']=='development':backend=FixtureBackend()
    elif engine=='mlx-vlm' and configuration['mode']=='live':backend=MlxVlmTextBackend()
    else:raise ValueError('RUNTIME_MODE_MISMATCH')
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    # Library diagnostics are not protocol output. The parent does not publish stderr.
    with contextlib.redirect_stdout(sys.stderr):backend.load(configuration,limits)
    emit({'type':'ready','modelLoaded':backend.model_loaded,'engine':engine})
    thread=None
    try:
        while not stopping.is_set():
            line=sys.stdin.buffer.readline(MAX_LINE+1)
            if not line:break
            if len(line)>MAX_LINE:raise ValueError('WORKER_INPUT_LIMIT')
            message=json.loads(line);op=message.get('op')
            if op=='close':break
            if op=='validate':
                try:
                    ids=backend.tokenize(request(message['request'],limits))
                    emit({'type':'validated','requestId':message['requestId'],'ok':True,'promptTokens':len(ids)})
                except Exception:emit({'type':'validated','requestId':message['requestId'],'ok':False,'code':'INPUT_TOKEN_LIMIT'})
            elif op=='generate':
                with active_lock:
                    if active:
                        emit({'type':'failed','jobId':message.get('jobId'),'code':'NATIVE_BUSY'});continue
                    cancelled=threading.Event();active=(message['jobId'],cancelled)
                thread=threading.Thread(target=generate,args=(message,limits,cancelled),daemon=True);thread.start()
            elif op=='cancel':
                with active_lock:
                    if active and active[0]==message.get('jobId'):active[1].set()
            else:raise ValueError('UNKNOWN_WORKER_COMMAND')
    finally:
        stop()
        if thread:thread.join(timeout=2)
        if thread and thread.is_alive():
            cleanup_temporary()
            os._exit(1)
    emit({'type':'closed'});

if __name__=='__main__':
    try:main()
    except Exception as exc:
        try:emit({'type':'boot-failed','code':'APP_NATIVE_BOOT_FAILED','diagnostic':safe_diagnostic(exc)})
        except Exception:pass
        sys.exit(1)
    finally:
        cleanup_temporary()
