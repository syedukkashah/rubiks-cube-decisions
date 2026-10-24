from random import Random

from app.engine import SUITE_RANGES, scramble
from app.runner.service import new_id
from app.schemas import Puzzle, PuzzleRequest, utc_now
from app.solver import shortest_distance


def generate_scrambles(body: PuzzleRequest):
    rng = Random(body.seed)
    for _ in range(body.count):
        length = body.scramble_length
        if length is None:
            length = rng.randint(*SUITE_RANGES[body.suite])
        yield scramble(rng, length)


def generate_puzzles(body: PuzzleRequest) -> list[Puzzle]:
    puzzles = []
    for moves, facelets in generate_scrambles(body):
        puzzles.append(
            Puzzle(
                puzzle_id=new_id("pz"),
                suite=body.suite,
                scramble_moves=moves,
                facelets=facelets,
                optimal_distance=shortest_distance(facelets) if body.suite != "extension" else None,
                created_at=utc_now(),
            )
        )
    return puzzles
