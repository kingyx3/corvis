# The caller MUST provide an immutable LiteLLM image reference, for example
# docker.litellm.ai/berriai/litellm@sha256:<digest>. Do not use a mutable tag in a
# production release.
ARG LITELLM_BASE_IMAGE
FROM ${LITELLM_BASE_IMAGE}

USER root
COPY --chown=1000:1000 entrypoint.py /app/corvis-litellm-entrypoint.py
COPY --chown=1000:1000 config.example.yaml /app/corvis-litellm.example.yaml
RUN chmod 0555 /app/corvis-litellm-entrypoint.py \
    && chmod 0444 /app/corvis-litellm.example.yaml

# The upstream image user varies across releases; returning to the numeric non-root user
# keeps the Corvis wrapper independent of an upstream username.
USER 1000
ENTRYPOINT ["python", "/app/corvis-litellm-entrypoint.py"]
