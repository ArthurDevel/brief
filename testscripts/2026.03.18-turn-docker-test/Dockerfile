FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gcc g++ libffi-dev libssl-dev && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir aiortc aioice httpx python-dotenv
COPY test_turn.py .
COPY .env .
CMD ["python", "test_turn.py"]
