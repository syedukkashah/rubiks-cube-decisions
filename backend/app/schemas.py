from datetime import UTC, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator

from app.engine import SUITE_RANGES

Suite = Literal["warmup", "primary", "extension"]
RunStatus = Literal["queued", "running", "completed", "cancelled", "failed"]
TrialStatus = Literal["pending", "running", "solved", "move_limit", "error"]
ErrorCode = Literal[
    "validation_error",
    "not_found",
    "conflict",
    "missing_api_key",
    "upstream_error",
    "upstream_timeout",
    "internal_error",
]
Move = Literal[
    "U",
    "U'",
    "U2",
    "D",
    "D'",
    "D2",
    "L",
    "L'",
    "L2",
    "R",
    "R'",
    "R2",
    "F",
    "F'",
    "F2",
    "B",
    "B'",
    "B2",
]
Facelets = Annotated[str, Field(pattern=r"^[URFDLB]{54}$")]
Category = Literal["decision", "frontier"]
MODEL_SPECS = (
    ("typesafe/jev-1.13", "Jev 1.13", "decision", "decisions_api"),
    ("openai/gpt-6-luna-decisions", "GPT-6 Luna Decisions", "decision", "decisions_api"),
    ("cloudflare/clef", "Cloudflare Clef", "decision", "decisions_api"),
    ("anthropic/claude-opus-5.5", "Claude Opus 5.5", "frontier", "chat_completions"),
)
MODEL_IDS = tuple(spec[0] for spec in MODEL_SPECS)


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Schema(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class ErrorInfo(Schema):
    code: ErrorCode
    message: str


class ErrorDetail(ErrorInfo):
    details: dict | None = None


class ErrorEnvelope(Schema):
    error: ErrorDetail


class Health(Schema):
    status: Literal["ok"] = "ok"
    contract_version: Literal["1.0.0"] = "1.0.0"
    api_key_configured: bool


class ModelInfo(Schema):
    id: str
    label: str
    category: Category
    interface: Literal["decisions_api", "chat_completions"]
    available: bool


class ModelsResponse(Schema):
    models: list[ModelInfo]


class PuzzleRequest(Schema):
    suite: Suite
    count: Annotated[StrictInt, Field(ge=1, le=50)]
    scramble_length: StrictInt | None = None
    seed: StrictInt | None = None

    @model_validator(mode="after")
    def suite_length(self):
        low, high = SUITE_RANGES[self.suite]
        if self.scramble_length is not None and not low <= self.scramble_length <= high:
            raise ValueError(f"scramble_length must be between {low} and {high} for {self.suite}")
        return self


class Puzzle(Schema):
    puzzle_id: str
    suite: Suite
    scramble_moves: list[Move]
    facelets: Facelets
    optimal_distance: int | None
    created_at: str


class PuzzlesResponse(Schema):
    puzzles: list[Puzzle]


class RunConfig(Schema):
    puzzle_ids: Annotated[list[str], Field(min_length=1)]
    model_ids: Annotated[list[str], Field(min_length=1)] = Field(
        default_factory=lambda: list(MODEL_IDS)
    )
    max_moves: Annotated[StrictInt, Field(ge=1, le=30)] = 30
    timeout_s: Annotated[float, Field(gt=0, strict=True)] = 60
    max_retries: Annotated[StrictInt, Field(ge=0)] = 2
    history_window: Annotated[StrictInt, Field(ge=0)] = 6
    concurrency: Annotated[StrictInt, Field(ge=1, le=4)] = 1

    @model_validator(mode="after")
    def valid_ids(self):
        if any(model not in MODEL_IDS for model in self.model_ids):
            raise ValueError("model_ids must be a subset of the benchmark model IDs")
        for name in ("puzzle_ids", "model_ids"):
            ids = getattr(self, name)
            if len(ids) != len(set(ids)):
                raise ValueError(f"{name} must not contain duplicates")
        return self


class RunAccepted(Schema):
    run_id: str
    status: Literal["queued"] = "queued"


class RunCancelled(Schema):
    run_id: str
    status: Literal["cancelled"] = "cancelled"


class MoveRecord(Schema):
    index: int = Field(ge=1)
    move: Move
    facelets_before: Facelets
    facelets_after: Facelets
    latency_ms: float = Field(ge=0)
    confidence: float | None = Field(ge=0, le=1)
    retries: int = Field(ge=0)


class Trial(Schema):
    trial_id: str
    run_id: str
    puzzle_id: str
    model_id: str
    status: TrialStatus = "pending"
    initial_facelets: Facelets
    current_facelets: Facelets
    moves: list[MoveRecord] = Field(default_factory=list)
    moves_used: int = 0
    solved: bool = False
    invalid_move_count: int = 0
    retry_count: int = 0
    timeout_count: int = 0
    total_time_s: float | None = None
    optimal_distance: int | None
    optimality_gap: int | None = None
    started_at: str | None = None
    finished_at: str | None = None
    error: ErrorInfo | None = None


class RunSummary(Schema):
    run_id: str
    status: RunStatus
    created_at: str
    finished_at: str | None


class RunsResponse(Schema):
    runs: list[RunSummary]


class RunSnapshot(RunSummary):
    config: RunConfig
    started_at: str | None = None
    last_seq: int = 0
    trials: list[Trial]


class RunStarted(Schema):
    trial_count: int


class TrialStarted(Schema):
    puzzle_id: str
    model_id: str
    initial_facelets: Facelets


class MoveRequested(Schema):
    move_index: int
    attempt: int


class MoveInvalid(MoveRequested):
    reason: Literal["illegal_move", "malformed_response", "timeout", "upstream_error"]
    raw_response: str


class MoveApplied(MoveRecord):
    moves_used: int
    solved: bool


class RunFinished(Schema):
    status: Literal["completed", "cancelled", "failed"]
    finished_at: str


EVENT_DATA = {
    "run_started": RunStarted,
    "trial_started": TrialStarted,
    "move_requested": MoveRequested,
    "move_invalid": MoveInvalid,
    "move_applied": MoveApplied,
    "trial_finished": Trial,
    "run_finished": RunFinished,
    "error": ErrorInfo,
}


class Event(Schema):
    seq: int = Field(ge=1)
    type: Literal[
        "run_started",
        "trial_started",
        "move_requested",
        "move_invalid",
        "move_applied",
        "trial_finished",
        "run_finished",
        "error",
    ]
    run_id: str
    trial_id: str | None
    ts: str
    data: dict

    @model_validator(mode="after")
    def payload_matches_type(self):
        EVENT_DATA[self.type].model_validate(self.data)
        return self


class ModelStats(Schema):
    model_id: str
    label: str
    category: Category
    trials: int
    solved_trials: int
    success_rate_pct: float | None
    avg_move_latency_ms: float | None
    avg_total_time_s: float | None
    total_moves: int
    avg_moves_per_trial: float | None
    avg_optimality_gap: float | None
    invalid_move_count: int
    retry_count: int
    timeout_count: int


class QuestionsAnswered(Schema):
    fastest_model_id: str | None
    highest_solve_rate_model_id: str | None
    best_optimality_gap_model_id: str | None
    fastest_is_also_best_quality: bool | None


class StatsResponse(Schema):
    run_id: str
    run_status: RunStatus
    models: list[ModelStats]
    questions_answered: QuestionsAnswered
