# Static-site tasks for quadrat-cropper-js.
#
#   make preview              # http://localhost:8080
#   make preview PORT=8000    # any other port
#   make test                 # detector suite (same as `npm test`)
#   make publish              # gate on the suite, push main, verify the live version
#   make deploy-status        # compare the local and live QD.VERSION
#
# 8080 is the default because the Google OAuth client setup documented in the
# README authorizes http://localhost:8080 for Drive access.
#
# There is no build step: GitHub Pages serves the repo root of `main` (legacy
# build), so publishing is a plain fast-forward push of committed work.

# Each recipe is one shell script: the publish steps share variables and must
# abort together.
.ONESHELL:
SHELL := /bin/sh

PORT ?= 8080
PYTHON ?= python3
REMOTE ?= origin
BRANCH ?= main
SITE ?= https://marinebon.org/quadrat-cropper-js
QD ?= js/qd.js
# Keep the suite invocation out of a $(MAKE) call: with .ONESHELL a recipe that
# contains $(MAKE) runs even under `make -n`, so a dry run of publish would
# actually deploy. Both targets use this one definition to stay in sync.
MAKE_TEST ?= npm test
# seconds to wait for the Pages rebuild to start serving the pushed version
DEPLOY_WAIT ?= 180

.PHONY: preview test publish deploy-status

preview:
	@printf 'Serving %s at http://localhost:%s  (Ctrl-C to stop)\n' "$(CURDIR)" "$(PORT)"
	$(PYTHON) -m http.server $(PORT) --bind 127.0.0.1

test:
	@$(MAKE_TEST)

# Publish refuses to run on a dirty checkout: `test` validates the working
# tree, while a push ships the committed tree — so a dirty publish would
# deploy code the suite never saw. Commit first, then `make publish`.
publish:
	@set -e
	cur=$$(git rev-parse --abbrev-ref HEAD)
	if [ "$$cur" != "$(BRANCH)" ]; then
	  printf 'publish: on "%s", not "%s" — switch branches first.\n' "$$cur" "$(BRANCH)" >&2
	  exit 1
	fi
	if [ -n "$$(git status --porcelain --untracked-files=no)" ]; then
	  printf 'publish: tracked files are modified — commit first, then re-run.\n\n' >&2
	  git status --short --untracked-files=no >&2
	  printf '\nThe suite validates the working tree, but a push ships the committed tree,\nso publishing now would deploy something the tests never saw.\n' >&2
	  exit 2
	fi
	untracked=$$(git ls-files --others --exclude-standard)
	if [ -n "$$untracked" ]; then
	  printf 'publish: warning — these untracked files will NOT be deployed:\n%s\n' "$$untracked" >&2
	fi
	$(MAKE_TEST)
	git fetch --quiet $(REMOTE) $(BRANCH)
	behind=$$(git rev-list --count HEAD..$(REMOTE)/$(BRANCH))
	if [ "$$behind" != 0 ]; then
	  printf 'publish: %s/%s is %s commit(s) ahead — pull or rebase first.\n' "$(REMOTE)" "$(BRANCH)" "$$behind" >&2
	  exit 1
	fi
	ahead=$$(git rev-list --count $(REMOTE)/$(BRANCH)..HEAD)
	if [ "$$ahead" = 0 ]; then
	  printf 'publish: already up to date — nothing to push.\n'
	  exit 0
	fi
	printf 'Publishing %s commit(s):\n' "$$ahead"
	git log --oneline --no-decorate -n "$$ahead" | sed 's/^/  /'
	git push $(REMOTE) $(BRANCH)
	ver=$$(sed -n "s/.*var VERSION *= *'\([^']*\)'.*/\1/p" $(QD))
	if [ -z "$$ver" ]; then
	  printf 'publish: pushed, but could not read QD.VERSION from %s — skipping the live check.\n' "$(QD)" >&2
	  exit 0
	fi
	fetch() {
	  if command -v curl >/dev/null 2>&1; then
	    curl -fsS -H 'Cache-Control: no-cache' "$$1"
	  else
	    $(PYTHON) -c 'import sys,urllib.request as u;sys.stdout.write(u.urlopen(sys.argv[1],timeout=20).read().decode())' "$$1"
	  fi
	}
	printf 'Waiting for GitHub Pages to serve v%s …\n' "$$ver"
	waited=0
	while [ "$$waited" -lt $(DEPLOY_WAIT) ]; do
	  sleep 5
	  waited=$$((waited + 5))
	  if fetch "$(SITE)/$(QD)?publish=$$(date +%s)$$waited" 2>/dev/null | grep -q "var VERSION = '$$ver'"; then
	    printf 'Live: %s  (QD.VERSION %s)\n' "$(SITE)/" "$$ver"
	    exit 0
	  fi
	done
	printf 'warning: %s is still serving an older build after %ss.\nSee https://github.com/marinebon/quadrat-cropper-js/deployments\n' "$(SITE)/" "$(DEPLOY_WAIT)" >&2

deploy-status:
	@vlocal=$$(sed -n "s/.*var VERSION *= *'\([^']*\)'.*/\1/p" $(QD))
	if command -v curl >/dev/null 2>&1; then
	  vlive=$$(curl -fsS -H 'Cache-Control: no-cache' "$(SITE)/$(QD)?$$(date +%s)" 2>/dev/null | sed -n "s/.*var VERSION *= *'\([^']*\)'.*/\1/p")
	else
	  vlive=''
	fi
	printf 'local  %s\n' "$${vlocal:-unknown}"
	printf 'live   %s  (%s)\n' "$${vlive:-unreachable}" "$(SITE)/"
	if [ -n "$$vlive" ] && [ -n "$$vlocal" ] && [ "$$vlive" = "$$vlocal" ]; then
	  printf 'in sync\n'
	fi
