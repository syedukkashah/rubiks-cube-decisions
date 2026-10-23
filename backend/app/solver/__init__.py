"""Complete bidirectional breadth-first search in the 18-move HTM graph."""

from functools import lru_cache

from app.engine import MOVES, SOLVED, inverse, turn, validate_facelets


@lru_cache(maxsize=4)
def _solved_ball(depth: int) -> dict[str, tuple[str, ...]]:
    paths: dict[str, tuple[str, ...]] = {SOLVED: ()}
    frontier = [SOLVED]
    for _ in range(depth):
        following = []
        for state in frontier:
            path = paths[state]
            for move in MOVES:
                # Same-face consecutive moves can always be shortened in HTM.
                if path and path[-1][0] == move[0]:
                    continue
                child = turn(state, move)
                if child not in paths:
                    paths[child] = (*path, move)
                    following.append(child)
        frontier = following
    return paths


def shortest_solution(facelets: str, max_depth: int = 5) -> list[str]:
    validate_facelets(facelets)
    if not 0 <= max_depth <= 5:
        raise ValueError("exact search supports depths 0 through 5")
    left_depth = max_depth // 2
    solved_paths = _solved_ball(left_depth)
    if facelets in solved_paths:
        return [inverse(m) for m in reversed(solved_paths[facelets])]
    paths: dict[str, tuple[str, ...]] = {facelets: ()}
    frontier = [facelets]
    for _ in range(max_depth - left_depth):
        following = []
        candidates = []
        for state in frontier:
            path = paths[state]
            for move in MOVES:
                if path and path[-1][0] == move[0]:
                    continue
                child = turn(state, move)
                if child in paths:
                    continue
                child_path = (*path, move)
                paths[child] = child_path
                following.append(child)
                if child in solved_paths:
                    candidates.append(
                        [*child_path, *(inverse(m) for m in reversed(solved_paths[child]))]
                    )
        # Finish the entire BFS layer before selecting the shortest intersection.
        if candidates:
            return min(candidates, key=len)
        frontier = following
    raise ValueError("state has no solution within max_depth")


def shortest_distance(facelets: str, max_depth: int = 5) -> int:
    return len(shortest_solution(facelets, max_depth))
