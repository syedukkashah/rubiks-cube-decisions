from app.engine import MOVES

INSTRUCTIONS = (
    "Choose exactly one next move to solve this 3x3 Rubik's Cube in as few HTM moves "
    "as possible. cube_facelets uses URFDLB face order, nine row-major stickers per face "
    "as seen from outside. Each letter denotes its home centre colour. "
    "The goal is six uniform faces. recent_moves lists the most recently applied moves. "
    "Use only one of the supplied choices. Clockwise is viewed from outside the turned face."
)
FACE_NAMES = {"U": "up", "D": "down", "L": "left", "R": "right", "F": "front", "B": "back"}
CRITERIA = {
    move: f"Turn the {FACE_NAMES[move[0]]} face "
    + (
        "180 degrees."
        if move.endswith("2")
        else "90 degrees counter-clockwise."
        if move.endswith("'")
        else "90 degrees clockwise."
    )
    for move in MOVES
}


def state_payload(state: str, recent_moves: list[str]) -> dict:
    return {"cube_facelets": state, "recent_moves": recent_moves}
