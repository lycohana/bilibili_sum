from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel

from video_sum_infra.config import ServiceSettings


class SettingsUpdatePayload(BaseModel):
    host: str | None = None
    port: int | None = None
    data_dir: str | None = None
    cache_dir: str | None = None
    tasks_dir: str | None = None
    database_url: str | None = None
    whisper_model: str | None = None
    whisper_device: str | None = None
    whisper_compute_type: str | None = None
    device_preference: str | None = None
    compute_type: str | None = None
    model_mode: str | None = None
    fixed_model: str | None = None
    cuda_variant: str | None = None
    output_dir: str | None = None
    preserve_temp_audio: bool | None = None
    enable_cache: bool | None = None
    language: str | None = None
    summary_mode: str | None = None
    llm_enabled: bool | None = None
    llm_provider: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None
    llm_api_key: str | None = None
    summary_system_prompt: str | None = None
    summary_user_prompt_template: str | None = None


class SettingsManager:
    def __init__(self, base_settings: ServiceSettings) -> None:
        self._base_settings = base_settings
        self._settings = base_settings
        self._settings_path = Path(base_settings.data_dir) / "settings.json"

    @property
    def current(self) -> ServiceSettings:
        return self._settings

    def load(self) -> ServiceSettings:
        if self._settings_path.exists():
            stored = json.loads(self._settings_path.read_text(encoding="utf-8"))
            self._settings = ServiceSettings.model_validate({**self._base_settings.model_dump(), **stored})
        else:
            self._settings = self._base_settings
        return self._settings

    def save(self, payload: SettingsUpdatePayload) -> ServiceSettings:
        current_dump = self._settings.model_dump(mode="json")
        updates = payload.model_dump(exclude_none=True)
        next_settings = ServiceSettings.model_validate({**current_dump, **updates})
        self._settings_path.parent.mkdir(parents=True, exist_ok=True)
        self._settings_path.write_text(
            json.dumps(next_settings.model_dump(mode="json"), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        self._settings = next_settings
        return self._settings
