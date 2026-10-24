from app.adapters.chat_completions import ChatAdapter
from app.adapters.decisions_api import DecisionsAdapter
from app.schemas import MODEL_SPECS

ADAPTERS = {"decisions_api": DecisionsAdapter, "chat_completions": ChatAdapter}
INTERFACES = {model_id: interface for model_id, _, _, interface in MODEL_SPECS}


def real_adapter(model_id, client, settings):
    return ADAPTERS[INTERFACES[model_id]](model_id, client, settings.api_key, settings)
