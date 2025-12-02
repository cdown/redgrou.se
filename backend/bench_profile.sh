#!/bin/bash
# Profile a single benchmark with samply
# Usage: ./bench_profile.sh <benchmark_name>
# Example: ./bench_profile.sh upload/1000

set -e

BENCH_NAME="${1:-upload/1000}"

echo "Building benchmark with profiling profile (with full debug symbols)..."
RUSTFLAGS="-C debuginfo=2" cargo build --bench api_benchmarks --features disable-rate-limits --profile profiling

# Find the benchmark binary
BENCH_BINARY=$(find target/profiling/deps -name "api_benchmarks-*" -type f -executable | head -1)

if [ -z "$BENCH_BINARY" ]; then
    echo "Error: Could not find benchmark binary"
    exit 1
fi

echo "Verifying binary has debug symbols..."
if file "$BENCH_BINARY" | grep -q "stripped"; then
    echo "Warning: Binary appears to be stripped. Rebuilding..."
    cargo clean --profile profiling
    cargo build --bench api_benchmarks --features disable-rate-limits --profile profiling
    BENCH_BINARY=$(find target/profiling/deps -name "api_benchmarks-*" -type f -executable | head -1)
fi

echo "Profiling benchmark: $BENCH_NAME"
echo "Running samply on compiled binary (this will only profile the benchmark execution, not the build)..."
echo "Note: Make sure you're in the backend directory so samply can find source files"
samply record "$BENCH_BINARY" -- "$BENCH_NAME"
