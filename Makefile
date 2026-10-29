# Local preview of the static site (the GitHub Pages root is the repo root).
#
#   make preview              # http://localhost:8080
#   make preview PORT=8000    # any other port
#
# 8080 is the default because the Google OAuth client setup documented in the
# README authorizes http://localhost:8080 for Drive access.

PORT ?= 8080
PYTHON ?= python3

.PHONY: preview
preview:
	@printf 'Serving %s at http://localhost:%s  (Ctrl-C to stop)\n' "$(CURDIR)" "$(PORT)"
	@$(PYTHON) -m http.server $(PORT) --bind 127.0.0.1
