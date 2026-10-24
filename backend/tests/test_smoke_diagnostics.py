import json
from dataclasses import replace

import httpx
import pytest
from test_guardrails import response

from app.adapters.base import UpstreamFailure
from app.adapters.chat_completions import ChatAdapter
from app.budget import SpendLedger
from app.config import CHAT_MODEL, Settings
from app.engine import MOVES, SOLVED
from scripts.live_smoke import run_smoke


@pytest.fixture
def settings(tmp_path):
    return Settings(
        mock_models=False,
        api_key="private-test-key",
        spend_ledger_path=tmp_path / "ledger.jsonl",
    )


@pytest.mark.parametrize("status", [200, 400, 403, 502, 503])
async def test_error_details_are_redacted_allowlisted_and_separate_from_api(settings, status):
    body = {
        "id": "gen-example",
        "error": {
            "code": 400 if status == 200 else status,
            "message": "Rejected private-test-key\nBearer other-secret",
            "metadata": {
                "provider_name": "Example provider",
                "error_type": "invalid_request",
                "provider_code": "invalid_request_error",
                "raw": json.dumps(
                    {
                        "error": {"message": "unsupported parameter sk-or-secret-value"},
                        "request": {"messages": ["DO NOT LOG PROMPTS"]},
                    }
                ),
                "headers": {"Authorization": "DO NOT LOG HEADERS"},
                "flagged_input": "DO NOT LOG FLAGGED INPUT",
            },
        },
    }
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                status, json=body, headers={"x-request-id": "req-example"}
            )
        )
    ) as client:
        with pytest.raises(UpstreamFailure) as caught:
            await ChatAdapter(CHAT_MODEL, client, settings.api_key, settings).choose_move(
                SOLVED, [], list(MOVES), 15
            )
    failure = caught.value
    assert failure.diagnostics == {
        "http_status": status,
        "upstream_code": 400 if status == 200 else status,
        "message": "Rejected [REDACTED] Bearer [REDACTED]",
        "error_type": "invalid_request",
        "provider_code": "invalid_request_error",
        "provider": "Example provider",
        "provider_message": "unsupported parameter [REDACTED]",
        "generation_id": "gen-example",
        "request_id": "req-example",
    }
    assert str(failure) == "OpenRouter request failed"


@pytest.mark.parametrize("kind", ["reasoning", "plain", "network", "timeout", "success"])
async def test_opus_diagnosis_makes_exactly_one_budgeted_call(settings, kind):
    calls, output = [], []

    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        assert body["model"] == CHAT_MODEL
        assert body["max_tokens"] == 160
        assert body["reasoning"]["effort"] == "low"
        assert body["provider"]["max_price"] == {"prompt": 4, "completion": 20}
        if kind == "reasoning":
            return httpx.Response(400, json={"error": {"message": "reasoning budget too small"}})
        if kind == "plain":
            return httpx.Response(502, text="private-test-key DO NOT LOG HTML")
        if kind == "network":
            raise httpx.ConnectError("private-test-key DO NOT LOG EXCEPTION", request=request)
        if kind == "timeout":
            raise httpx.ReadTimeout("private-test-key", request=request)
        return response(CHAT_MODEL)

    result = await run_smoke(
        settings, transport=httpx.MockTransport(handler), emit=output.append, diagnose_opus=True
    )
    assert result == (0 if kind == "success" else 1)
    assert len(calls) == SpendLedger(settings).live_calls == 1
    saved = settings.spend_ledger_path.read_text()
    assert "private-test-key" not in saved + "\n".join(output)
    assert "DO NOT LOG" not in "\n".join(output)
    if kind == "network":
        assert json.loads(output[1])["transport_error"] == "ConnectError"
    elif kind == "timeout":
        assert json.loads(output[1])["transport_error"] == "ReadTimeout"
    elif kind == "plain":
        assert json.loads(output[1])["http_status"] == 502
    elif kind == "reasoning":
        assert json.loads(output[1])["message"] == "reasoning budget too small"


@pytest.mark.parametrize("setting", ["mock", "key", "budget", "mixed_modes"])
async def test_diagnosis_keeps_safety_checks(settings, setting):
    if setting == "mock":
        settings = replace(settings, mock_models=True)
    elif setting == "key":
        settings = replace(settings, api_key="")
    elif setting == "budget":
        settings = replace(settings, max_spend_usd=0)

    def no_call(request):
        pytest.fail("Refused diagnostic must not make any HTTP request")

    result = await run_smoke(
        settings,
        calibrate=setting == "mixed_modes",
        transport=httpx.MockTransport(no_call),
        emit=lambda _: None,
        diagnose_opus=True,
    )
    assert result != 0
    assert not settings.spend_ledger_path.exists()


async def test_diagnostics_bound_messages_without_dumping_unstructured_provider_body(settings):
    body = {"error": {"message": "x" * 2000, "metadata": {"raw": "DO NOT LOG RAW"}}}
    output = []
    await run_smoke(
        settings,
        transport=httpx.MockTransport(lambda request: httpx.Response(400, json=body)),
        emit=output.append,
        diagnose_opus=True,
    )
    assert len(json.loads(output[1])["message"]) == 1000
    assert "DO NOT LOG RAW" not in "\n".join(output)


@pytest.mark.parametrize("tokens", [480, 600, 601, None])
@pytest.mark.parametrize("calibrate", [False, True])
async def test_approved_prompt_guard_stops_remaining_calibration_calls(settings, tokens, calibrate):
    calls, output = [], []

    def handler(request):
        calls.append(request)
        body = response(CHAT_MODEL).json()
        body["usage"]["prompt_tokens"] = tokens
        return httpx.Response(200, json=body)

    result = await run_smoke(
        settings,
        calibrate=calibrate,
        diagnose_opus=not calibrate,
        transport=httpx.MockTransport(handler),
        emit=output.append,
    )
    accepted = tokens is not None and tokens <= 600
    assert result == (0 if accepted else 1)
    assert len(calls) == (3 if calibrate and accepted else 1)
    assert SpendLedger(settings).live_calls == len(calls)
    if not accepted:
        assert any("prompt_tokens missing or above 600" in line for line in output)
        assert not any("Recommended CHAT_MAX_TOKENS=" in line for line in output)
