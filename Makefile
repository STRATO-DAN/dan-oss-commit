# [DAN] COMMIT — developer/CI entry points. Pure stdlib + your existing `git`/`node`; no dependency to
# install and nothing here talks to the network. `make help` lists every target.
#
# Portable on purpose: each recipe is a single command (no .ONESHELL), so it runs the same on the
# stock macOS make (3.81) and on GNU make.

NODE ?= node

.DEFAULT_GOAL := help
.PHONY: help test attack demo bench

help: ## Show this help
	@echo "[DAN] COMMIT — make targets:"
	@echo ""
	@echo "  make test     Run the full test suite (node --test test/*.test.mjs)."
	@echo "  make attack   Run ONLY the adversarial/security tests and the secret-gate suite."
	@echo "  make demo     Reproducible, offline demo: read a real diff, then trip the secret gate."
	@echo "  make bench    Secret-scan throughput on a ~1 MB diff (elapsed ms + MB/s, linear-time)."
	@echo "  make help     Show this help."
	@echo ""
	@echo "All targets are stdlib-only, need no network, and use no real API key."

test: ## Run the full test suite
	$(NODE) --test test/*.test.mjs

attack: ## Run only the adversarial + secret-gate tests
	@echo "=============================================================================="
	@echo " make attack — adversarial surface only"
	@echo " security.test.mjs : 401 auth / 415 content-type / 409 snapshot-CAS / 422 control"
	@echo "                     chars / 429 rate limit / oversize body / hostile-repo filters"
	@echo " secrets.test.mjs  : the deny-by-default SECRET GATE (422, no LLM call) + the"
	@echo "                     linear-time, ReDoS-safe secret scan"
	@echo "=============================================================================="
	$(NODE) --test test/security.test.mjs test/secrets.test.mjs

demo: ## Reproducible offline demo (real diff, then the secret gate)
	@sh scripts/demo.sh

bench: ## Secret-scan throughput on a ~1 MB synthetic diff
	@$(NODE) scripts/bench.mjs
