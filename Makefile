PREFIX ?= $(HOME)/.local
BIN := $(PREFIX)/bin
TARGET := $(CURDIR)/dist/acm.mjs
LINK := $(BIN)/acm

.PHONY: install build link uninstall check test clean

# Install acm: builds the bundle and links it onto PATH
install: link
	@echo
	@echo "Installed. If acm is not found, add $(BIN) to PATH."

build:
	bun install
	bun run build:acm

# Link only into an empty slot or over this repo's own link: any other file or link there is left
# as it is, so installing never replaces something this Makefile did not create.
link: build
	@mkdir -p $(BIN)
	@if [ -L "$(LINK)" ] && [ "$$(readlink "$(LINK)")" != "$(TARGET)" ]; then \
		echo "refusing: $(LINK) already links to $$(readlink "$(LINK)"); remove it or use another PREFIX" >&2; \
		exit 1; \
	elif [ ! -L "$(LINK)" ] && [ -e "$(LINK)" ]; then \
		echo "refusing: $(LINK) exists and is not a symlink; remove it or use another PREFIX" >&2; \
		exit 1; \
	fi
	ln -sf "$(TARGET)" "$(LINK)"

uninstall:
	@if [ -L "$(LINK)" ] && [ "$$(readlink "$(LINK)")" = "$(TARGET)" ]; then \
		rm -f "$(LINK)"; \
		echo "removed $(LINK)"; \
	elif [ -L "$(LINK)" ] || [ -e "$(LINK)" ]; then \
		echo "left $(LINK) alone: it is not the link this Makefile created"; \
	else \
		echo "nothing to remove at $(LINK)"; \
	fi

check:
	bun run check

test:
	bun run test

clean:
	rm -rf dist
