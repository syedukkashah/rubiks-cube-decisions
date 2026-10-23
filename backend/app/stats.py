from statistics import mean

from app.schemas import MODEL_SPECS, ModelStats, QuestionsAnswered, RunSnapshot, StatsResponse


def average(values):
    return mean(values) if values else None


def compute_stats(run: RunSnapshot) -> StatsResponse:
    models = []
    specs = {i: (label, category) for i, label, category, _ in MODEL_SPECS}
    for model_id in run.config.model_ids:
        trials = [trial for trial in run.trials if trial.model_id == model_id]
        label, category = specs[model_id]
        moves = [move for trial in trials for move in trial.moves]
        solved = sum(trial.solved for trial in trials)
        total_moves = sum(trial.moves_used for trial in trials)
        models.append(
            ModelStats(
                model_id=model_id,
                label=label,
                category=category,
                trials=len(trials),
                solved_trials=solved,
                success_rate_pct=100 * solved / len(trials) if trials else None,
                avg_move_latency_ms=average([move.latency_ms for move in moves]),
                avg_total_time_s=average(
                    [t.total_time_s for t in trials if t.total_time_s is not None]
                ),
                total_moves=total_moves,
                avg_moves_per_trial=total_moves / len(trials) if trials else None,
                avg_optimality_gap=average(
                    [t.optimality_gap for t in trials if t.optimality_gap is not None]
                ),
                invalid_move_count=sum(t.invalid_move_count for t in trials),
                retry_count=sum(t.retry_count for t in trials),
                timeout_count=sum(t.timeout_count for t in trials),
            )
        )

    def best(field, maximize=False):
        candidates = [model for model in models if getattr(model, field) is not None]
        if not candidates:
            return None
        choose = max if maximize else min
        return choose(candidates, key=lambda model: getattr(model, field)).model_id

    fastest = best("avg_move_latency_ms")
    quality = best("avg_optimality_gap")
    rate = (
        best("success_rate_pct", maximize=True)
        if any(trial.status in {"solved", "move_limit", "error"} for trial in run.trials)
        else None
    )
    also_best = None
    if fastest is not None and quality is not None and rate is not None:
        # Compare values: tied models share the best quality, even if ID tie-breaking differs.
        by_id = {model.model_id: model for model in models}
        also_best = (
            by_id[fastest].success_rate_pct == by_id[rate].success_rate_pct
            and by_id[fastest].avg_optimality_gap == by_id[quality].avg_optimality_gap
        )
    return StatsResponse(
        run_id=run.run_id,
        run_status=run.status,
        models=models,
        questions_answered=QuestionsAnswered(
            fastest_model_id=fastest,
            highest_solve_rate_model_id=rate,
            best_optimality_gap_model_id=quality,
            fastest_is_also_best_quality=also_best,
        ),
    )
