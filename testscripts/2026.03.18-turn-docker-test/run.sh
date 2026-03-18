#!/bin/bash
set -e
cd "$(dirname "$0")"
docker build -t turn-docker-test .
docker run --rm turn-docker-test
