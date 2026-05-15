ANTHROPIC_API_VERSION = "2023-06-01"


def normalize_openai_compatible_model_name(model: str) -> str:
    normalized = str(model or "").strip()
    if normalized.lower().startswith("mimo-"):
        return normalized.lower()
    return normalized


def normalize_llm_provider(provider: str | None) -> str:
    normalized = str(provider or "").strip().lower()
    if normalized in {"anthropic", "claude"}:
        return "anthropic"
    if normalized in {"openai", "openai-compatible", "openai_compatible", "custom"}:
        return normalized.replace("_", "-")
    return "openai-compatible"


def is_anthropic_llm(provider: str | None, base_url: str | None = None) -> bool:
    if normalize_llm_provider(provider) == "anthropic":
        return True
    normalized_base_url = str(base_url or "").strip().lower()
    return "api.anthropic.com" in normalized_base_url


def anthropic_messages_url(base_url: str) -> str:
    normalized = str(base_url or "").strip().rstrip("/")
    if normalized.endswith("/messages"):
        return normalized
    return f"{normalized}/messages"


def openai_chat_completions_url(base_url: str) -> str:
    normalized = str(base_url or "").strip().rstrip("/")
    if normalized.endswith("/chat/completions"):
        return normalized
    return f"{normalized}/chat/completions"


def build_anthropic_messages_payload(payload: dict[str, object]) -> dict[str, object]:
    messages = payload.get("messages")
    system_parts: list[str] = []
    anthropic_messages: list[dict[str, object]] = []
    if isinstance(messages, list):
        for item in messages:
            if not isinstance(item, dict):
                continue
            role = str(item.get("role") or "").strip().lower()
            content = item.get("content")
            if role == "system":
                text = extract_text_from_content_blocks(content)
                if text:
                    system_parts.append(text)
                continue
            if role not in {"user", "assistant"}:
                role = "user"
            anthropic_messages.append({"role": role, "content": content if content is not None else ""})

    request_payload: dict[str, object] = {
        "model": str(payload.get("model") or "").strip(),
        "messages": anthropic_messages or [{"role": "user", "content": ""}],
        "max_tokens": int(payload.get("max_tokens") or 1024),
    }
    if system_parts:
        request_payload["system"] = "\n\n".join(system_parts)
    if "temperature" in payload and payload.get("temperature") is not None:
        request_payload["temperature"] = payload["temperature"]
    if payload.get("stream") is True:
        request_payload["stream"] = True
    return request_payload


def extract_text_from_content_blocks(content: object) -> str:
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    text_parts: list[str] = []
    for item in content:
        if isinstance(item, str):
            if item.strip():
                text_parts.append(item.strip())
            continue
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            text_parts.append(text.strip())
            continue
        nested_content = item.get("content")
        nested_text = extract_text_from_content_blocks(nested_content)
        if nested_text:
            text_parts.append(nested_text)
    return "\n".join(text_parts).strip()
