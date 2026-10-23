from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from app.adapters.chat_completions import ChatAdapter
from app.adapters.decisions_api import DecisionsAdapter
from app.adapters.mock import MockAdapter
from app.adapters.registry import ModelRegistry
from app.api.routes import APIError, router
from app.config import Settings
from app.runner.service import BenchmarkService
from app.schemas import ErrorDetail, ErrorEnvelope


class UTF8JSONResponse(JSONResponse):
    media_type = "application/json; charset=utf-8"


def error_response(status, code, message, details=None):
    return UTF8JSONResponse(
        status_code=status,
        content=ErrorEnvelope(
            error=ErrorDetail(
                code=code,
                message=message,
                details=details,
            )
        ).model_dump(),
    )


def create_app(settings: Settings | None = None, adapter_factory=None, transport=None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(transport=transport) as client:
            registry = ModelRegistry(client, settings.mock_models)

            def factory(model_id, puzzle):
                if settings.mock_models:
                    return MockAdapter(puzzle.scramble_moves)
                adapter = (
                    ChatAdapter if model_id == "anthropic/claude-opus-5.5" else DecisionsAdapter
                )
                return adapter(model_id, client, settings.api_key)

            app.state.registry = registry
            app.state.service = BenchmarkService(adapter_factory or factory, settings.api_key)
            try:
                yield
            finally:
                await app.state.service.close()

    app = FastAPI(
        title="Rubik's Cube Race",
        version="1.0.0",
        lifespan=lifespan,
        default_response_class=UTF8JSONResponse,
    )
    app.state.settings = settings
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "Last-Event-ID"],
    )

    @app.exception_handler(APIError)
    async def api_error(request: Request, error: APIError):
        return error_response(error.status, error.code, error.message, error.details)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError):
        # Exclude supplied values/context: request bodies may accidentally contain secrets.
        errors = [
            {"field": ".".join(map(str, e["loc"])), "type": e["type"]} for e in error.errors()
        ]
        return error_response(
            422, "validation_error", "Request validation failed", {"errors": errors}
        )

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, error: HTTPException):
        if error.status_code == 404:
            return error_response(404, "not_found", "Resource not found")
        return error_response(422, "validation_error", "Unsupported HTTP request")

    @app.exception_handler(Exception)
    async def internal_error(request: Request, error: Exception):
        return error_response(500, "internal_error", "Unexpected backend failure")

    app.include_router(router)
    return app


app = create_app()
