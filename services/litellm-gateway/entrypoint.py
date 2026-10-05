#!/usr/bin/env python3
"""Start LiteLLM with a minimal generated Corvis model map.

Provider credentials arrive as one Secret Manager JSON value and are materialized only in
the child process. Non-secret model routing arrives in CORVIS_LITELLM_MODELS_JSON and is
rendered to /tmp so production does not depend on a checked-in placeholder config.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile

KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,127}$")
ALIAS_RE = re.compile(r"^corvis-extract-[a-z0-9-]+$")
CREDENTIAL_SUFFIXES = (
    "_API_KEY",
    "_ACCESS_KEY_ID",
    "_SECRET_ACCESS_KEY",
    "_SESSION_TOKEN",
    "_AUTH_TOKEN",
    "_CLIENT_SECRET",
    "_PASSWORD",
    "_CREDENTIAL",
    "_CREDENTIALS",
    "_SECRET",
    "_TOKEN",
)
DEFAULT_PROVIDER_KEYS = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "azure": "AZURE_API_KEY",
    "bedrock": "AWS_SECRET_ACCESS_KEY",
}


def provider_credentials(raw: str) -> dict[str, str]:
    if not raw.strip():
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("CORVIS_AI_PROVIDER_CREDENTIALS_JSON is not valid JSON") from exc
    if not isinstance(value, dict):
        raise ValueError("CORVIS_AI_PROVIDER_CREDENTIALS_JSON must be a JSON object")

    result: dict[str, str] = {}
    for key, secret in value.items():
        if not isinstance(key, str) or not KEY_RE.fullmatch(key):
            raise ValueError("provider credential keys must be uppercase environment-variable names")
        if key.startswith(("CORVIS_", "LITELLM_", "GITHUB_", "PYTHON")) or not key.endswith(CREDENTIAL_SUFFIXES):
            raise ValueError(f"provider credential key is not an allowed credential-shaped name: {key}")
        if not isinstance(secret, str) or not secret:
            raise ValueError(f"provider credential value must be a non-empty string: {key}")
        result[key] = secret
    return result


def model_entries(raw: str) -> list[dict[str, str | None]]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("CORVIS_LITELLM_MODELS_JSON is not valid JSON") from exc
    if not isinstance(value, dict) or not value:
        raise ValueError("CORVIS_LITELLM_MODELS_JSON must be a non-empty object")

    result: list[dict[str, str | None]] = []
    for alias, spec in value.items():
        if not isinstance(alias, str) or not ALIAS_RE.fullmatch(alias):
            raise ValueError(f"invalid Corvis model alias: {alias}")
        if isinstance(spec, str):
            model = spec.strip()
            api_key_env = None
        elif isinstance(spec, dict):
            model = str(spec.get("model", "")).strip()
            raw_key = spec.get("apiKeyEnv") or spec.get("api_key_env")
            api_key_env = str(raw_key).strip() if raw_key else None
        else:
            raise ValueError(f"model mapping for {alias} must be a string or object")
        if "/" not in model or any(character.isspace() for character in model):
            raise ValueError(f"model mapping for {alias} must be provider/model")
        provider = model.split("/", 1)[0]
        if api_key_env is None:
            api_key_env = DEFAULT_PROVIDER_KEYS.get(provider)
        if api_key_env is not None and not KEY_RE.fullmatch(api_key_env):
            raise ValueError(f"invalid apiKeyEnv for {alias}")
        result.append({"alias": alias, "model": model, "api_key_env": api_key_env})
    return result


def render_config(entries: list[dict[str, str | None]], environment: dict[str, str]) -> str:
    lines = ["model_list:"]
    for entry in entries:
        alias = str(entry["alias"])
        model = str(entry["model"])
        api_key_env = entry["api_key_env"]
        lines.extend([
            f"  - model_name: {json.dumps(alias)}",
            "    litellm_params:",
            f"      model: {json.dumps(model)}",
        ])
        if api_key_env:
            if api_key_env not in environment:
                raise ValueError(f"model {alias} requires missing provider credential {api_key_env}")
            lines.append(f"      api_key: os.environ/{api_key_env}")
    lines.extend([
        "general_settings:",
        "  master_key: os.environ/LITELLM_MASTER_KEY",
        "  disable_spend_logs: true",
        "router_settings:",
        "  num_retries: 2",
        "  retry_after: 1",
        "  timeout: 420",
    ])
    return "\n".join(lines) + "\n"


def main() -> None:
    credentials = provider_credentials(os.environ.get("CORVIS_AI_PROVIDER_CREDENTIALS_JSON", ""))
    environment = os.environ.copy()
    environment.update(credentials)
    environment.pop("CORVIS_AI_PROVIDER_CREDENTIALS_JSON", None)

    if not environment.get("LITELLM_MASTER_KEY"):
        raise SystemExit("LITELLM_MASTER_KEY is required")
    entries = model_entries(environment.get("CORVIS_LITELLM_MODELS_JSON", ""))

    configured_path = environment.get("CORVIS_LITELLM_CONFIG", "").strip()
    if configured_path:
        if not os.path.isfile(configured_path):
            raise SystemExit(f"LiteLLM config not found: {configured_path}")
        config = configured_path
    else:
        rendered = render_config(entries, environment)
        handle = tempfile.NamedTemporaryFile(mode="w", prefix="corvis-litellm-", suffix=".yaml", delete=False)
        try:
            handle.write(rendered)
            handle.flush()
            os.fchmod(handle.fileno(), 0o400)
            config = handle.name
        finally:
            handle.close()

    executable = shutil.which("litellm")
    if not executable:
        raise SystemExit("LiteLLM executable not found in PATH")
    port = environment.get("PORT", "4000")
    if not port.isdigit() or not 1 <= int(port) <= 65535:
        raise SystemExit("PORT must be an integer between 1 and 65535")

    os.execve(executable, [executable, "--config", config, "--host", "0.0.0.0", "--port", port], environment)


if __name__ == "__main__":
    main()
