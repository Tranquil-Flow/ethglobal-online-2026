"""Application-owned text backend. Model imports and load are explicit and lazy."""
import gc
import hashlib
import importlib.metadata
import platform
import time
from pathlib import Path
from types import SimpleNamespace
from codec import StreamAssembly

class Cancelled(Exception):
    pass

class FixtureBackend:
    model_loaded = False
    def load(self, configuration, limits):
        self.configuration = configuration
        self.limits = limits
    def tokenize(self, request):
        ids = [ord(c) for c in request['prompt']]
        if len(ids) > self.limits['maxPromptTokens']:
            raise ValueError('INPUT_TOKEN_LIMIT')
        return ids
    def generate(self, request, cancelled):
        ids = self.tokenize(request)
        stream = StreamAssembly(request['maxOutputTokens'])
        selected = ids[:request['maxOutputTokens']]
        for index, token in enumerate(selected):
            if cancelled.is_set(): raise Cancelled()
            time.sleep(0.01)
            if cancelled.is_set(): raise Cancelled()
            value = stream.consume(SimpleNamespace(text=chr(token), token=token, generation_tokens=index+1, finish_reason=None))
            yield {'type':'delta', **value}
        if len(selected) == request['maxOutputTokens']:
            final = SimpleNamespace(text='', token=selected[-1], generation_tokens=len(selected), finish_reason='length')
        else:
            final = SimpleNamespace(text='', token=0, generation_tokens=len(selected)+1, finish_reason='stop')
        value=stream.consume(final)
        if value['text'] or value['tokenIds']: yield {'type':'delta', **value}
        yield {'type':'completed','output':stream.output(),'inputIds':ids,'selectedTokenIds':stream.selected,'mlxBytes':0}
    def cleanup(self):
        pass

class MlxVlmTextBackend:
    model_loaded = False
    def load(self, configuration, limits):
        self.configuration=configuration;self.limits=limits
        versions=configuration['runtimeVersions']
        if platform.python_version()!=versions['python']:
            raise ValueError('PYTHON_VERSION_MISMATCH')
        for package in ('mlx','mlx-vlm','transformers'):
            if importlib.metadata.version(package)!=versions[package]:
                raise ValueError('RUNTIME_VERSION_MISMATCH')
        root=Path(configuration['modelDirectory'])
        if not root.is_dir() or root.is_symlink():raise ValueError('MODEL_DIRECTORY_REQUIRED')
        total=sum(x['bytes'] for x in configuration['modelFiles'])
        if total>limits['maxMlxBytes']:raise ValueError('MODEL_MEMORY_ENVELOPE_TOO_SMALL')
        for item in configuration['modelFiles']:
            name=item['name'];path=root/name
            if Path(name).name!=name or path.is_symlink() or not path.is_file() or path.stat().st_size!=item['bytes']:
                raise ValueError('MODEL_ASSET_MISMATCH')
            h=hashlib.sha256()
            with path.open('rb') as stream:
                for chunk in iter(lambda:stream.read(8*1024*1024),b''):h.update(chunk)
            if h.hexdigest()!=item['sha256']:raise ValueError('MODEL_ASSET_MISMATCH')
        import psutil
        if psutil.virtual_memory().available < total + 536870912:raise ValueError('MODEL_HOST_HEADROOM_REQUIRED')
        import mlx.core as mx
        if not mx.metal.is_available():raise ValueError('METAL_REQUIRED_NO_CPU_FALLBACK')
        mx.set_memory_limit(limits['maxMlxBytes'])
        from mlx_vlm.utils import load_model, StoppingCriteria
        from mlx_vlm.tokenizer_utils import load_tokenizer
        from transformers import AutoTokenizer
        self.mx=mx
        # The stream API explicitly supports a PreTrainedTokenizer and input_ids.
        # No unused image/video processor is constructed or checkpoint JSON edited.
        self.tokenizer=AutoTokenizer.from_pretrained(str(root),local_files_only=True,trust_remote_code=False)
        detokenizer_class=load_tokenizer(root,return_tokenizer=False)
        self.tokenizer.detokenizer=detokenizer_class(self.tokenizer)
        self.model=load_model(root,lazy=False,strict=True)
        self.weights_loaded=True
        eos=getattr(self.model.config,'eos_token_id',None) or getattr(self.tokenizer,'eos_token_ids',None) or self.tokenizer.eos_token_id
        self.tokenizer.stopping_criteria=StoppingCriteria(eos,self.tokenizer)
        self.model_loaded=True
    def tokenize(self, request):
        ids=self.tokenizer.apply_chat_template([{'role':'user','content':request['prompt']}],tokenize=True,add_generation_prompt=True,enable_thinking=False,return_dict=False)
        if not isinstance(ids,list) or not ids or any(type(x) is not int or x<0 for x in ids) or len(ids)>self.limits['maxPromptTokens']:
            raise ValueError('INPUT_TOKEN_LIMIT')
        return ids
    def generate(self, request, cancelled):
        from mlx_vlm.generate import stream_generate
        ids=self.tokenize(request);stream=StreamAssembly(request['maxOutputTokens'])
        self.mx.random.seed(0)
        iterator=stream_generate(self.model,self.tokenizer,'',input_ids=self.mx.array([ids],dtype=self.mx.int32),max_tokens=request['maxOutputTokens'],temperature=0.0,verbose=False,enable_thinking=False,skip_special_tokens=False,prefill_step_size=128)
        try:
            for result in iterator:
                if cancelled.is_set():raise Cancelled()
                value=stream.consume(result)
                if int(self.mx.get_active_memory())>self.limits['maxMlxBytes']:raise ValueError('MLX_MEMORY_LIMIT')
                if value['text'] or value['tokenIds']:yield {'type':'delta',**value}
            if cancelled.is_set():raise Cancelled()
            output=stream.output()
        finally:
            iterator.close()
            self.cleanup()
        yield {'type':'completed','output':output,'inputIds':ids,'selectedTokenIds':stream.selected,'mlxBytes':int(self.mx.get_peak_memory())}
    def cleanup(self):
        gc.collect()
        self.mx.synchronize()
        self.mx.clear_cache()
