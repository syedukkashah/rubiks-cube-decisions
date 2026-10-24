import httpx
import pytest


@pytest.fixture(autouse=True)
def forbid_real_http(monkeypatch):
    async def deny_async(*args, **kwargs):
        raise AssertionError("Real HTTP is forbidden in this offline test suite")

    def deny_sync(*args, **kwargs):
        raise AssertionError("Real HTTP is forbidden in this offline test suite")

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", deny_async)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", deny_sync)
