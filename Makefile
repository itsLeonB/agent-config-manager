PREFIX ?= $(HOME)/.local
BIN := $(PREFIX)/bin

.PHONY: install build link uninstall check test clean

# Install acm, then register it with each harness: acm setup
install: link
	@echo
	@echo "Next: acm setup"
	@echo "If acm is not found, add $(BIN) to PATH."

build:
	bun install
	bun run build:acm

link: build
	@mkdir -p $(BIN)
	ln -sf $(CURDIR)/dist/acm.mjs $(BIN)/acm

uninstall:
	rm -f $(BIN)/acm

check:
	bun run check

test:
	bun run test

clean:
	rm -rf dist
