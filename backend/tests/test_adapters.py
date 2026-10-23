import json

import httpx
import pytest

from app.adapters.base import UpstreamFailure
from app.adapters.chat_completions import ChatAdapter
from app.adapters.decisions_api import DecisionsAdapter
from app.adapters.prompts import CRITERIA, INSTRUCTIONS
from app.engine import MOVES, SOLVED


async def test_decisions_wire_format_and_confidence():
    def handler(request):
        assert request.url.path == "/api/alpha/decisions"
        body = json.loads(request.content)
        assert body["state"] == {"cube_facelets": SOLVED, "recent_moves": ["R"]}
        assert body["questions"]["next_move"] == {
            "type": "choice",
            "instructions": INSTRUCTIONS,
            "criteria": CRITERIA,
        }
        return httpx.Response(
            200,
            json={
                "answers": {
                    "next_move": {
                        "type": "choice",
                        "choice": "R'",
                        "probabilities": {"R'": 0.75},
                    }
                }
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await DecisionsAdapter("typesafe/jev-1.13", client, "test-key").choose_move(
            SOLVED,
            ["R"],
            list(MOVES),
            1,
        )
    assert result.move == "R'"
    assert result.confidence == 0.75
    assert result.latency_ms >= 0


@pytest.mark.parametrize(
    "content,expected",
    [
        ('{"move":"R"}', "R"),
        ('{"move":"R3"}', "R3"),
        ('```json\n{"move":"R"}\n```', None),
        ('{"move":"R","extra":true}', None),
        ('{"move":42}', None),
        ("not json", None),
    ],
)
async def test_chat_strict_parsing(content, expected):
    def handler(request):
        body = json.loads(request.content)
        assert request.url.path == "/api/v1/chat/completions"
        assert body["messages"][0]["content"].startswith(INSTRUCTIONS)
        assert body["response_format"]["json_schema"]["schema"]["properties"]["move"]["enum"] == (
            list(MOVES)
        )
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await ChatAdapter("anthropic/claude-opus-5.5", client, "test-key").choose_move(
            SOLVED,
            [],
            list(MOVES),
            1,
        )
    assert result.move == expected


async def test_upstream_error_does_not_expose_key():
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(401, text="private-test-key"))
    ) as client:
        adapter = DecisionsAdapter("typesafe/jev-1.13", client, "private-test-key")
        with pytest.raises(UpstreamFailure) as error:
            await adapter.choose_move(SOLVED, [], list(MOVES), 1)
    assert "private-test-key" not in str(error.value)


async def test_raw_response_redacted():
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, text="private-test-key Bearer secret-value")
        )
    ) as client:
        result = await DecisionsAdapter(
            "typesafe/jev-1.13", client, "private-test-key"
        ).choose_move(
            SOLVED,
            [],
            list(MOVES),
            1,
        )
    assert result.move is None
    assert "private-test-key" not in result.raw_response
    assert "secret-value" not in result.raw_response
