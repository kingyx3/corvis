#!/usr/bin/env python3
"""Start LiteLLM after safely materializing provider credentials from one JSON secret.

The JSON value is expected in CORVIS_AI_PROVIDER_CREDENTIALS_JSON. Keys become process
environment variables for LiteLLM; values are never printed. Only credential-shaped names
are accepted so a secret payload cannot mutate the Python/network/runtime control plane.
"""

from __future__ import annotations

import json
import os
import re
import shutil

KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,127}$")
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
