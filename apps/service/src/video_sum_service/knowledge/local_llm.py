from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass

import httpx
from fastapi import HTTPException

from video_sum_infra.config import ServiceSettings
from video_sum_infra.llm import (
    ANTHROPIC_API_VERSION,
    anthropic_messages_url,
    build_anthropic_messages_payload,
    is_anthropic_llm,
    normalize_openai_compatible_model_name,
    openai_chat_completions_url,
)
from video_sum_service.integrations import extract_http_error_detail, extract_llm_message_content

logger = logging.getLogger(__name__)

KNOWLEDGE_LLM_TIMEOUT = httpx.Timeout(connect=15.0, read=45.0, write=30.0, pool=30.0)
KNOWLEDGE_LLM_STREAM_TIMEOUT = httpx.Timeout(connect=15.0, read=12.0, write=30.0, pool=30.0)
KNOWLEDGE_LLM_FIRST_CONTENT_TIMEOUT_SECONDS = 18.0


@dataclass(frozen=True)
class KnowledgeLlmStreamEvent:
    kind: str
    delta: str


def resolve_knowledge_llm_settings(settings: ServiceSettings) -> tuple[bool, str, str, str, str]:
    mode = str(getattr(settings, "knowledge_llm_mode", "same_as_main") or "same_as_main").strip().lower()
    if mode == "custom":
        provider = str(getattr(settings, "knowledge_llm_provider", "openai-compatible") or "openai-compatible").strip()
        enabled = bool(getattr(settings, "knowledge_llm_enabled", False))
        base_url = str(getattr(settings, "knowledge_llm_base_url", "") or "").strip().rstrip("/")
        model = str(getattr(settings, "knowledge_llm_model", "") or "").strip()
        api_key = str(getattr(settings, "knowledge_llm_api_key", "") or "").strip()
        return enabled, base_url, model, api_key, provider

    provider = str(getattr(settings, "llm_provider", "openai-compatible") or "openai-compatible").strip()
    enabled = bool(getattr(settings, "llm_enabled", False))
    base_url = str(getattr(settings, "llm_base_url", "") or "").strip().rstrip("/")
    model = str(getattr(settings, "llm_model", "") or "").strip()
    api_key = str(getattr(settings, "llm_api_key", "") or "").strip()
    return enabled, base_url, model, api_key, provider


def knowledge_llm_available(settings: ServiceSettings) -> bool:
    enabled, base_url, model, api_key, _provider = resolve_knowledge_llm_settings(settings)
    return bool(enabled and base_url and api_key and model)


def ensure_knowledge_llm_settings(settings: ServiceSettings) -> tuple[str, str, str, str]:
    enabled, base_url, model, api_key, provider = resolve_knowledge_llm_settings(settings)
    if not enabled:
        raise HTTPException(status_code=400, detail="知识库问答和自动打标需要先启用知识库 LLM。")
    if not base_url or not api_key or not model:
        raise HTTPException(status_code=400, detail="知识库问答和自动打标需要先填写知识库 LLM 的 API Key、地址和模型名。")
    return base_url, model, api_key, provider


def chat_knowledge_llm(
    settings: ServiceSettings,
    *,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 800,
    temperature: float = 0.2,
    require_json: bool = False,
) -> tuple[str, dict[str, object] | None]:
    base_url, model, api_key, provider = ensure_knowledge_llm_settings(settings)
    use_anthropic = is_anthropic_llm(provider, base_url)
    request_model = model if use_anthropic else normalize_openai_compatible_model_name(model)
    headers = {"Content-Type": "application/json"}
    if use_anthropic:
        if api_key:
            headers["x-api-key"] = api_key
        headers["anthropic-version"] = ANTHROPIC_API_VERSION
    elif api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload: dict[str, object] = {
        "model": request_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if require_json:
        payload["response_format"] = {"type": "json_object"}
        payload["enable_thinking"] = False
        payload["chat_template_kwargs"] = {"enable_thinking": False}
    request_url = anthropic_messages_url(base_url) if use_anthropic else openai_chat_completions_url(base_url)
    request_payload = build_anthropic_messages_payload(payload) if use_anthropic else payload

    started_at = time.monotonic()
    logger.info("knowledge llm request start mode=chat base_url=%s model=%s max_tokens=%s", base_url, model, max_tokens)
    try:
        with httpx.Client(timeout=KNOWLEDGE_LLM_TIMEOUT, follow_redirects=True) as client:
            response = client.post(request_url, headers=headers, json=request_payload)
    except httpx.ReadTimeout as exc:
        elapsed_ms = int((time.monotonic() - started_at) * 1000)
        logger.warning("knowledge llm request timeout mode=chat model=%s elapsed_ms=%s", model, elapsed_ms)
        raise HTTPException(
            status_code=504,
            detail="知识库 LLM 响应超时：模型返回过慢，请稍后重试，或换更快的模型 / 减少上下文。",
        ) from exc
    except httpx.HTTPError as exc:
        elapsed_ms = int((time.monotonic() - started_at) * 1000)
        logger.warning("knowledge llm request failed mode=chat model=%s elapsed_ms=%s error=%s", model, elapsed_ms, exc)
        raise HTTPException(status_code=502, detail=f"知识库 LLM 连接失败：{exc}") from exc

    elapsed_ms = int((time.monotonic() - started_at) * 1000)
    logger.info(
        "knowledge llm response received mode=chat model=%s status_code=%s elapsed_ms=%s",
        model,
        response.status_code,
        elapsed_ms,
    )

    if response.status_code >= 400:
        detail = extract_http_error_detail(response)
        raise HTTPException(status_code=response.status_code, detail=f"知识库 LLM 调用失败：{detail}")

    try:
        body = response.json()
    except ValueError:
        body = None

    content = extract_llm_message_content(body)
    if not content:
        raise HTTPException(status_code=502, detail="知识库 LLM 没有返回可读取内容。")
    return content, body if isinstance(body, dict) else None


def _extract_stream_reasoning_delta(payload: dict[str, object]) -> str:
    message = payload.get("message")
    if isinstance(message, dict):
        reasoning = message.get("reasoning_content")
        if isinstance(reasoning, str):
            return reasoning

    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    delta = first.get("delta")
    if isinstance(delta, dict):
        reasoning = delta.get("reasoning_content")
        if isinstance(reasoning, str):
            return reasoning
    message = first.get("message")
    if isinstance(message, dict):
        reasoning = message.get("reasoning_content")
        if isinstance(reasoning, str):
            return reasoning
    return ""


def _extract_stream_delta(payload: dict[str, object]) -> str:
    delta_type = payload.get("type")
    if delta_type == "content_block_delta":
        delta = payload.get("delta")
        if isinstance(delta, dict):
            text = delta.get("text")
            if isinstance(text, str):
                return text
    if delta_type == "content_block_start":
        content_block = payload.get("content_block")
        if isinstance(content_block, dict):
            text = content_block.get("text")
            if isinstance(text, str):
                return text

    message = payload.get("message")
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, str):
            return content

    for key in ("response", "text", "content"):
        value = payload.get(key)
        if isinstance(value, str):
            return value

    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    delta = first.get("delta")
    if not isinstance(delta, dict):
        return ""
    content = delta.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text_parts: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            text = item.get("text")
            if isinstance(text, str):
                text_parts.append(text)
        return "".join(text_parts)
    return ""


def stream_knowledge_llm(
    settings: ServiceSettings,
    *,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 800,
    temperature: float = 0.2,
    should_cancel: Callable[[], bool] | None = None,
) -> Iterator[KnowledgeLlmStreamEvent]:
    base_url, model, api_key, provider = ensure_knowledge_llm_settings(settings)
    use_anthropic = is_anthropic_llm(provider, base_url)
    request_model = model if use_anthropic else normalize_openai_compatible_model_name(model)
    headers = {"Content-Type": "application/json"}
    if use_anthropic:
        if api_key:
            headers["x-api-key"] = api_key
        headers["anthropic-version"] = ANTHROPIC_API_VERSION
    elif api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload: dict[str, object] = {
        "model": request_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
    }
    request_url = anthropic_messages_url(base_url) if use_anthropic else openai_chat_completions_url(base_url)
    request_payload = build_anthropic_messages_payload(payload) if use_anthropic else payload
    should_stop = should_cancel or (lambda: False)

    started_at = time.monotonic()
    opened_at: float | None = None
    first_delta_logged = False
    first_activity_logged = False
    delta_count = 0
    reasoning_delta_count = 0
    logger.info("knowledge llm request start mode=stream base_url=%s model=%s max_tokens=%s", base_url, model, max_tokens)
    try:
        with httpx.Client(timeout=KNOWLEDGE_LLM_STREAM_TIMEOUT, follow_redirects=True) as client:
            with client.stream("POST", request_url, headers=headers, json=request_payload) as response:
                opened_at = time.monotonic()
                elapsed_ms = int((time.monotonic() - started_at) * 1000)
                logger.info(
                    "knowledge llm stream opened model=%s status_code=%s elapsed_ms=%s",
                    model,
                    response.status_code,
                    elapsed_ms,
                )
                if response.status_code >= 400:
                    detail = extract_http_error_detail(response)
                    raise HTTPException(status_code=response.status_code, detail=f"知识库 LLM 调用失败：{detail}")

                for raw_line in response.iter_lines():
                    if should_stop():
                        return
                    if not first_activity_logged and opened_at is not None:
                        wait_seconds = time.monotonic() - opened_at
                        if wait_seconds > KNOWLEDGE_LLM_FIRST_CONTENT_TIMEOUT_SECONDS:
                            elapsed_ms = int((time.monotonic() - started_at) * 1000)
                            logger.warning(
                                "knowledge llm first activity timeout model=%s elapsed_ms=%s wait_seconds=%.1f",
                                model,
                                elapsed_ms,
                                wait_seconds,
                            )
                            raise HTTPException(
                                status_code=504,
                                detail="知识库 LLM 已建立连接但迟迟没有输出内容：当前模型首包过慢，请稍后重试或换更快的知识库模型。",
                            )
                    line = str(raw_line or "").strip()
                    if not line or line.startswith(":"):
                        continue
                    if not line.startswith("data:"):
                        continue
                    chunk = line[5:].strip()
                    if not chunk or chunk == "[DONE]":
                        continue
                    try:
                        body = json.loads(chunk)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(body, dict):
                        continue
                    reasoning_delta = _extract_stream_reasoning_delta(body)
                    if reasoning_delta:
                        reasoning_delta_count += 1
                        if not first_activity_logged:
                            first_activity_logged = True
                            elapsed_ms = int((time.monotonic() - started_at) * 1000)
                            logger.info("knowledge llm first reasoning delta model=%s elapsed_ms=%s", model, elapsed_ms)
                        yield KnowledgeLlmStreamEvent(kind="reasoning", delta=reasoning_delta)
                    delta = _extract_stream_delta(body)
                    if delta:
                        delta_count += 1
                        first_activity_logged = True
                        if not first_delta_logged:
                            first_delta_logged = True
                            elapsed_ms = int((time.monotonic() - started_at) * 1000)
                            logger.info("knowledge llm first stream delta model=%s elapsed_ms=%s", model, elapsed_ms)
                        yield KnowledgeLlmStreamEvent(kind="content", delta=delta)
    except httpx.ReadTimeout as exc:
        elapsed_ms = int((time.monotonic() - started_at) * 1000)
        logger.warning(
            "knowledge llm request timeout mode=stream model=%s elapsed_ms=%s delta_count=%s reasoning_delta_count=%s",
            model,
            elapsed_ms,
            delta_count,
            reasoning_delta_count,
        )
        raise HTTPException(
            status_code=504,
            detail="知识库 LLM 响应超时：模型返回过慢，请稍后重试，或换更快的模型 / 减少上下文。",
        ) from exc
    except httpx.HTTPError as exc:
        elapsed_ms = int((time.monotonic() - started_at) * 1000)
        logger.warning("knowledge llm request failed mode=stream model=%s elapsed_ms=%s error=%s", model, elapsed_ms, exc)
        raise HTTPException(status_code=502, detail=f"知识库 LLM 连接失败：{exc}") from exc
    finally:
        elapsed_ms = int((time.monotonic() - started_at) * 1000)
        logger.info(
            "knowledge llm stream finished model=%s elapsed_ms=%s delta_count=%s reasoning_delta_count=%s",
            model,
            elapsed_ms,
            delta_count,
            reasoning_delta_count,
        )


def parse_json_payload(text: str) -> dict[str, object]:
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail=f"知识库 LLM 没有返回合法 JSON：{exc.msg}") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=502, detail="知识库 LLM 返回的 JSON 结构不符合预期。")
    return payload
