import asyncio

from app.schemas import Event, RunSnapshot, utc_now


class EventLog:
    def __init__(self, snapshot: RunSnapshot):
        self.snapshot = snapshot
        self.events: list[Event] = []
        self.changed = asyncio.Event()
        self.on_event = None

    def emit(
        self, event_type: str, data: dict, trial_id: str | None = None, *, ts: str | None = None
    ):
        event = Event(
            seq=len(self.events) + 1,
            type=event_type,
            run_id=self.snapshot.run_id,
            trial_id=trial_id,
            ts=ts if ts is not None else utc_now(),
            data=data,
        )
        # Serialize now so later trial mutations cannot alter historical events.
        event = Event.model_validate_json(event.model_dump_json())
        self.events.append(event)
        self.snapshot.last_seq = event.seq
        if self.on_event is not None:
            self.on_event()
        self.changed.set()

    async def stream(self, after_seq: int, heartbeat_s: float = 10):
        cursor = after_seq
        while True:
            self.changed.clear()
            for event in self.events[cursor:]:
                yield f"id: {event.seq}\nevent: {event.type}\ndata: {event.model_dump_json()}\n\n"
                cursor = event.seq
                if event.type == "run_finished":
                    return
            if self.events and self.events[-1].type == "run_finished":
                return
            try:
                await asyncio.wait_for(self.changed.wait(), timeout=heartbeat_s)
            except TimeoutError:
                yield ": ping\n\n"
