from app.engine import MOVES

INSTRUCTIONS = "Min moves.URFDLB:9 row-major/face;letters=centres;CW/CCW=90,outside."
SHORT_ANSWER = 'Reply immediately with only {"move":"<one allowed move>"}. No explanation.'
CRITERIA = {
    move: "180" if move.endswith("2") else "CCW" if move.endswith("'") else "CW" for move in MOVES
}
# Equivalent to the 18-value enum, including rejection of trailing newlines.
MOVE_PATTERN = r"^[UDLRFB]['2]?(?![\s\S])"


def state_payload(state: str, recent_moves: list[str]) -> dict:
    return {"cube_facelets": state, "recent_moves": recent_moves}
