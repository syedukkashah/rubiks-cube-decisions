from random import Random

import pytest

from app.engine import MOVES, SOLVED, apply_move, inverse, is_solved, scramble
from app.solver import shortest_distance, shortest_solution


@pytest.mark.parametrize("move", MOVES)
def test_move_inverse_and_order(move):
    state = apply_move(SOLVED, move)
    assert state != SOLVED
    assert apply_move(state, inverse(move)) == SOLVED
    for _ in range(3):
        state = apply_move(state, move)
    assert is_solved(state)


def test_normative_r_example():
    assert apply_move(SOLVED, "R") == ("UUFUUFUUFRRRRRRRRRFFDFFDFFDDDBDDBDDBLLLLLLLLLUBBUBBUBB")


@pytest.mark.parametrize("bad", ["R3", "r", " R", "R’", "", None])
def test_illegal_move_rejected(bad):
    with pytest.raises(ValueError):
        apply_move(SOLVED, bad)


def test_scramble_reproducibility():
    for length in (3, 4, 5, 15, 20):
        moves, state = scramble(Random(42), length)
        assert (moves, state) == scramble(Random(42), length)
        assert len(moves) == length
        assert all(a[0] != b[0] for a, b in zip(moves, moves[1:]))
        replay = SOLVED
        for move in moves:
            replay = apply_move(replay, move)
        assert replay == state != SOLVED


@pytest.mark.parametrize(
    "moves,distance",
    [
        ([], 0),
        (["R"], 1),
        (["R", "R"], 1),
        (["R", "U"], 2),
        (["R", "U", "U'"], 1),
        (["R", "U", "F"], 3),
    ],
)
def test_exact_distance(moves, distance):
    state = SOLVED
    for move in moves:
        state = apply_move(state, move)
    assert shortest_distance(state) == distance


def test_five_turn_solution():
    _, state = scramble(Random(31), 5)
    solution = shortest_solution(state)
    assert len(solution) <= 5
    for move in solution:
        state = apply_move(state, move)
    assert state == SOLVED
