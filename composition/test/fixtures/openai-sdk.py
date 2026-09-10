"""Ordinary installed OpenAI SDK against LOCAL conformance composition only.

No wallet or live authorizer is implemented here. Inputs arrive over private stdin.
"""
import json
import sys
import urllib.request
import openai
from openai import OpenAI, APIStatusError, APIConnectionError

args=json.load(sys.stdin)
origin=args['origin'];assert origin.startswith('http://127.0.0.1:')
cap=args['capability']
client=OpenAI(base_url=origin+'/v1',api_key=cap,max_retries=0,timeout=10)
models=client.models.list();assert models.object=='list'
model=models.data[0].id
base={'model':model,'messages':[{'role':'user','content':'synthetic SDK café 🌙'}],'max_tokens':3}

def complete(key,stream=False):
    options={**base,'stream':stream,'extra_headers':{'Idempotency-Key':key}}
    try:
        return client.chat.completions.create(**options)
    except APIStatusError as error:
        assert error.status_code==402
        challenge=error.response.json()['mycelium']
        assert challenge['quote']['mode']=='development'
        # This explicit development-only helper never exists in the live viewer.
        req=urllib.request.Request(origin+'/development/authorize',method='POST',
            headers={'Content-Type':'application/json','x-ethonline-development':'synthetic-only'},
            data=json.dumps({'body':challenge['payment_required'],'quote':challenge['quote']}).encode())
        with urllib.request.urlopen(req,timeout=10) as response:proof=json.load(response)
        options['extra_headers'].update(proof)
        return client.chat.completions.create(**options)

response_loss_observed=False
try:
    first=complete('generic-openai-sdk-nonstream')
except APIConnectionError:
    assert args.get('expect_response_loss') is True
    response_loss_observed=True
    first=complete('generic-openai-sdk-nonstream')
assert response_loss_observed is bool(args.get('expect_response_loss'))
assert first.object=='chat.completion' and first.choices[0].message.content=='é🌙'
assert first.usage is None
# The scripted gateway exhausts this three-token request; preserve native length termination.
assert first.choices[0].finish_reason=='length'
assert first.mycelium['execution_verified'] is False
assert first.mycelium['financial_protection'] is False
again=complete('generic-openai-sdk-nonstream');assert again.id==first.id
chunks=list(complete('generic-openai-sdk-stream',True))
assert ''.join(c.choices[0].delta.content or '' for c in chunks)=='é🌙'
assert sum(c.choices[0].finish_reason is not None for c in chunks)==1
print(json.dumps({'sdk_version':openai.__version__,'scope':'local-scripted-native-conformance-not-inference-no-funds',
    'original_chat':base,'response_loss_observed':response_loss_observed,'model':model,'nonstream_job':first.mycelium['job_id'],'stream_job':chunks[0].id.removeprefix('chatcmpl-'),
    'finish_reason':first.choices[0].finish_reason,'sdk_recovery_same_job':again.id==first.id},sort_keys=True))
client.close()
