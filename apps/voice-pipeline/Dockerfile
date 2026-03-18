FROM python:3.12-slim

WORKDIR /app

# Install system dependencies required by pipecat/webrtc
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        gcc g++ libffi-dev libssl-dev \
        libxcb1 libx11-6 libgl1 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 7860

CMD ["python", "-m", "src.server"]
