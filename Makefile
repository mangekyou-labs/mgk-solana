.PHONY: help build-bpf build-sbpf-linker build test clean

help:
	@echo "On-Chain Perps DEX Build Targets"
	@echo ""
	@echo "  make build-bpf         - Build programs with standard Solana SDK"
	@echo "  make build-sbpf-linker - Build programs with sbpf-linker (nightly)"
	@echo "  make build             - Build all programs (native)"
	@echo "  make test              - Run unit tests"
	@echo "  make clean             - Clean build artifacts"
	@echo ""

build-bpf:
	@echo "Building BPF programs (standard SDK)..."
	@cargo build-sbf

build-sbpf-linker:
	@echo "Building BPF programs (sbpf-linker + nightly)..."
	@./build-sbpf-linker.sh

build:
	@echo "Building native..."
	@cargo build --lib --all

test:
	@echo "Running unit tests..."
	@cargo test --lib

clean:
	@echo "Cleaning..."
	@cargo clean
