# Iter worker image: Python plus the OpenAI client. The worker's own directory
# (iter.py, tools, channels, memory) is mounted at /agent by the docker driver.
ARG BASE_IMAGE=python:3.11-slim
FROM ${BASE_IMAGE}
RUN pip install --no-cache-dir openai && useradd --create-home --uid 10001 dot
USER dot
WORKDIR /agent
CMD ["python3", "/agent/iter.py"]
