"""Unmodified installed OpenAI SDK against explicit synthetic application."""
import json
import sys
from typing import Any
from urllib.parse import urlsplit
import openai
from openai import OpenAI
args = json.load(sys.stdin)
u = urlsplit(args['url'])
assert u.scheme == 'http' and u.hostname == '127.0.0.1'
with OpenAI(base_url=args['url']+'/v1', api_key=args['capability'], max_retries=0, timeout=15) as client:
    models = client.models.list().data
    assert len(models) >= 2
    for i, model in enumerate(models[:2]):
        request: dict[str, Any] = dict(model=model.id, messages=[{'role':'user','content':'🌙é synthetic SDK'}], max_tokens=4,
                       extra_headers={'Idempotency-Key':f'managed-stock-{i}'})
        chunks = list(client.chat.completions.create(**request, stream=True))
        final = client.chat.completions.create(**request)
        assert ''.join(c.choices[0].delta.content or '' for c in chunks) == '🌙é s'
        assert final.choices[0].message.content == '🌙é s'
        assert final.choices[0].finish_reason == 'length'
        assert all(c.usage is None for c in chunks)
        assert final.mycelium['execution_verified'] is False
        assert final.mycelium['financial_protection'] is False
print(json.dumps({'status':'passed','sdk':openai.__version__,'providers':2,'scope':'synthetic-managed-application-no-model-no-funds'}))
