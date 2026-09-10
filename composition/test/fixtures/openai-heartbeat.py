"""Real stock SDK, synthetic local executor; no model, checker or funds."""
import asyncio
import json
import sys
from urllib.parse import urlsplit

import openai
from openai import APIError, AsyncOpenAI, OpenAI

args = json.load(sys.stdin)
url = urlsplit(args["url"])
assert url.scheme == "http" and url.hostname == "127.0.0.1" and url.port
options = dict(base_url=args["url"] + "/v1", api_key=args["capability"],
               max_retries=0, timeout=10)
request = dict(model=args["model"], max_tokens=2,
               messages=[{"role": "user", "content": "synthetic heartbeat fixture"}],
               extra_headers={"Idempotency-Key": "heartbeat-fixture"})


def checked(chunks, final):
    assert "".join(c.choices[0].delta.content or "" for c in chunks) == "é🌙"
    assert [c.choices[0].finish_reason for c in chunks] == [None, None, "length"]
    assert all(c.id == final.id and c.usage is None for c in chunks)
    assert final.choices[0].message.content == "é🌙"
    assert final.choices[0].finish_reason == "length"
    assert final.mycelium["execution_verified"] is False
    assert final.mycelium["financial_protection"] is False
    return {"chunks": len(chunks), "job_id": final.mycelium["job_id"], "error": None}


def failed(chunks, error):
    assert args["fail_execution"] is True
    assert error.code == "EXECUTION_FAILED", repr(error)
    assert len(chunks) == 1 and chunks[0].choices[0].delta.content == "é"
    assert chunks[0].choices[0].finish_reason is None
    return {"chunks": 1, "error": error.code}


def sync_run():
    with OpenAI(**options) as client:
        chunks = []
        try:
            with client.chat.completions.create(**request, stream=True) as stream:
                for chunk in stream:
                    chunks.append(chunk)
        except APIError as error:
            return failed(chunks, error)
        assert args["fail_execution"] is False
        return checked(chunks, client.chat.completions.create(**request))


async def async_run():
    async with AsyncOpenAI(**options) as client:
        chunks = []
        try:
            async with await client.chat.completions.create(**request, stream=True) as stream:
                async for chunk in stream:
                    chunks.append(chunk)
        except APIError as error:
            return failed(chunks, error)
        assert args["fail_execution"] is False
        return checked(chunks, await client.chat.completions.create(**request))


assert args["client"] in ("sync", "async")
result = sync_run() if args["client"] == "sync" else asyncio.run(async_run())
print(json.dumps({**result, "sdk": openai.__version__, "scope": "synthetic-local-http-no-model-no-funds"}))
