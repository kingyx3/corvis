#!/usr/bin/env python3
"""Start LiteLLM after safely materializing provider credentials from one JSON secret.

The JSON value is expected in CORVIS_AI_PROVIDER_CREDENTIALS_JSON. Keys become process
environment variables for LiteLLM; values are never printed. The entrypoint rejects keys
that could alter the process/runtime control plane rather than authenticate a provider.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys

KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,127}$")
PROTECTED_EXACT = {
    "DATABASE_URL",
    "HOME",
    "HOST",
    "LD_PRELOAD",
    "PATH",
    "PORT",
    "PYTHONPATH",
}
PROTECTED_PREFIXES = ("CORVIS_", "LITELLM_", "PYTHON", "GITHUB_", "GOOGLE_APPLICATION_CREDENTIALS")


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
        if key in PROTECTED_EXACT or key.startswith(PROTECTED_PREFIXES):
            raise ValueError(f"provider credential key is reserved: {key}")
        if not isinstance(secret, str) or not secret:
            raise ValueError(f"provider credential value must be a non-empty string: {key}")
        result[key] = secret
    return result


def main() -> None:
    credentials = provider_credentials(os.environ.get("CORVIS_AI_PROVIDER_CREDENTIALS_JSON", ""))
    environment = os.environ.copy()
    environment.update(credentials)
    # Remove the aggregate secret before the gateway starts so child tools cannot accidentally
    # forward the whole credential map. Individual provider variables remain available.
    environment.pop("CORVIS_AI_PROVIDER_CREDENTIALS_JSON", None)

    config = os.environ.get("CORVIS_LITELLM_CONFIG", "/app/corvis-litellm.yaml")
    if not os.path.isfile(config):
        raise SystemExit(f"LiteLLM config not found: {config}")
    executable = shutil.which("litellm")
    if not executable:
        raise SystemExit("LiteLLM executable not found in PATH")

    port = os.environ.get("PORT", "4000")
    if not port.isdigit() or not 1 <= int(port) <= 65535:
        raise SystemExit("PORT must be an integer between 1 and 65535")

    os.execve(executable, [executable, "--config", config, "--host", "0.0.0.0", "--port", port], environment)


if __name__ == "__main__":
    main()
