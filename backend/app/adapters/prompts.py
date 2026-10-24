from app.engine import MOVES

# Shared steering: preserve the same task and deliberation instruction for all
# four models. This is soft guidance, not a guarantee of short reasoning.
INSTRUCTIONS = (
    "Pick a move.Min moves.No deliberation."
    "URFDLB:9/face,row-major;letters=centres;CW/CCW=90,outside."
)
SHORT_ANSWER = 'Reply immediately with only {"move":"<one allowed move>"}. No explanation.'
CRITERIA = {
    move: "180" if move.endswith("2") else "CCW" if move.endswith("'") else "CW" for move in MOVES
}
# Use only Anthropic's supported regex subset (no lookaround). Exact membership
# validation in ChatAdapter also rejects trailing newlines across regex dialects.
MOVE_PATTERN = r"^[UDLRFB]['2]?$"


def state_payload(state: str, recent_moves: list[str]) -> dict:
    return {"cube_facelets": state, "recent_moves": recent_moves}
