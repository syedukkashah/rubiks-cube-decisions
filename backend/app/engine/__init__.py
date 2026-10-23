"""Pure facelet permutations in Kociemba URFDLB order.

Coordinates: x points right, y up, z front. Each sticker is a position
and outward normal; a clockwise turn is -90 degrees about the face normal.
"""

from collections import Counter
from random import Random

FACES = "URFDLB"
SOLVED = "".join(face * 9 for face in FACES)
MOVES = tuple(face + suffix for face in "UDLRFB" for suffix in ("", "'", "2"))
SUITE_RANGES = {"warmup": (3, 4), "primary": (4, 5), "extension": (15, 20)}


def _stickers():
    for face in FACES:
        for row in range(3):
            for col in range(3):
                yield {
                    "U": ((col - 1, 1, row - 1), (0, 1, 0)),
                    "R": ((1, 1 - row, 1 - col), (1, 0, 0)),
                    "F": ((col - 1, 1 - row, 1), (0, 0, 1)),
                    "D": ((col - 1, -1, 1 - row), (0, -1, 0)),
                    "L": ((-1, 1 - row, col - 1), (-1, 0, 0)),
                    "B": ((1 - col, 1 - row, -1), (0, 0, -1)),
                }[face]


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b, strict=True))


def _rotate(vector, axis):
    x, y, z = vector
    a, b, c = axis
    cross = (b * z - c * y, c * x - a * z, a * y - b * x)
    dot = _dot(vector, axis)
    return tuple(axis[i] * dot - cross[i] for i in range(3))


def _permutations():
    stickers = list(_stickers())
    indices = {sticker: i for i, sticker in enumerate(stickers)}
    permutations = {}
    for face in FACES:
        axis = stickers[FACES.index(face) * 9 + 4][1]
        permutation = list(range(54))
        for old, (position, normal) in enumerate(stickers):
            if _dot(position, axis) == 1:
                new = indices[(_rotate(position, axis), _rotate(normal, axis))]
                permutation[new] = old
        permutations[face] = tuple(permutation)
        permutations[face + "2"] = tuple(permutation[permutation[i]] for i in range(54))
        permutations[face + "'"] = tuple(
            permutation[permutation[permutation[i]]] for i in range(54)
        )
    return permutations


PERMUTATIONS = _permutations()


def validate_facelets(facelets: str) -> None:
    if not isinstance(facelets, str) or Counter(facelets) != Counter(SOLVED):
        raise ValueError("facelets must contain exactly nine of each URFDLB face")
    if any(facelets[i * 9 + 4] != face for i, face in enumerate(FACES)):
        raise ValueError("facelet centres must be in URFDLB order")


def turn(facelets: str, move: str) -> str:
    """Fast permutation for already-validated internal states."""
    return "".join(map(facelets.__getitem__, PERMUTATIONS[move]))


def apply_move(facelets: str, move: str) -> str:
    if not isinstance(move, str) or move not in MOVES:
        raise ValueError("illegal move")
    validate_facelets(facelets)
    return turn(facelets, move)


def inverse(move: str) -> str:
    if move not in MOVES:
        raise ValueError("illegal move")
    return move if move.endswith("2") else move[0] if move.endswith("'") else move + "'"


def is_solved(facelets: str) -> bool:
    validate_facelets(facelets)
    return all(len(set(facelets[i : i + 9])) == 1 for i in range(0, 54, 9))


def scramble(rng: Random, length: int) -> tuple[list[str], str]:
    if length < 1:
        raise ValueError("scramble length must be positive")
    while True:
        moves: list[str] = []
        state = SOLVED
        for _ in range(length):
            move = rng.choice([m for m in MOVES if not moves or m[0] != moves[-1][0]])
            moves.append(move)
            state = turn(state, move)
        if state != SOLVED:
            return moves, state
