import asyncio

from app.adapters.base import UpstreamFailure, Usage
from app.engine import MOVES


async def call_model(
    adapter,
    state,
    history,
    timeout_s,
    ledger=None,
    run_id="",
    trial_id="",
    model_id="",
    on_result=None,
):
    ticket = await ledger.reserve(run_id, trial_id, model_id) if ledger is not None else None
    usage, result, failure = Usage(), None, None
    try:
        result = await asyncio.wait_for(
            adapter.choose_move(state, history, list(MOVES), timeout_s),
            timeout_s,
        )
        usage = result.usage
        return result
    except UpstreamFailure as error:
        usage, failure = error.usage, error
        raise
    except TimeoutError:
        failure = UpstreamFailure("upstream_timeout")
        raise failure from None
    finally:
        # Cancellation/crashes leave the durable estimate in place. No double row.
        if ticket is not None and (result is not None or failure is not None):
            await ledger.settle(ticket, usage)
        if on_result is not None and (result is not None or failure is not None):
            on_result(result, failure)
