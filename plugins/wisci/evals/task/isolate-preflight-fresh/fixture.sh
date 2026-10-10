#!/usr/bin/env bash
exec uv run --no-config --no-cache --script "$(dirname "$0")/../../_fixture/make_fixture.py" "$PWD"
