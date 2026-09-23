# Secret-detection patterns kaizen can vendor

Research for [#5](https://github.com/oakgreencc/kaizen/issues/5), part of #1 (v0.2: scrub secrets from transcript summaries before the model reads them).
Researched 2026-09-22 against each project's default branch. Versions at that time: gitleaks v8.30.1, secretlint v13.0.5, detect-secrets v1.5.0 (last release 2024-05-06), trufflehog v3.97.6.

**Question.** Which secret-pattern set should kaizen (AGPL-3.0, zero-dependency, Node 20+) vendor, and what token families must it cover?

**Answer.** Vendor a **curated subset of gitleaks' `config/gitleaks.toml`** (MIT), converted once to a JS module by a checked-in generator script. Add a few secretlint-style rules (MIT) for the families gitleaks misses: database connection strings and basic-auth URLs. Write the TOTP `otpauth://` rule yourself, because none of the candidates ship one. Use only rules anchored on a prefix or structure. Leave out `generic-api-key` and entropy-only detection by default.

---

## 1. Comparison

| | **gitleaks** | **secretlint** (preset-recommend) | **detect-secrets** (Yelp) | **trufflehog** | **GitHub secret scanning** |
|---|---|---|---|---|---|
| License | MIT, "Copyright (c) 2019 Zachary Rice" ([LICENSE](https://github.com/gitleaks/gitleaks/blob/master/LICENSE)) | MIT, "Copyright (c) 2020 azu" ([LICENSE](https://github.com/secretlint/secretlint/blob/master/LICENSE)); per-package `"license": "MIT"` | Apache-2.0, "Copyright 2017-2018 Yelp Inc." ([LICENSE](https://github.com/Yelp/detect-secrets/blob/master/LICENSE)); no NOTICE file in repo root | **AGPL-3.0** ([LICENSE](https://github.com/trufflesecurity/trufflehog/blob/main/LICENSE)) | Docs are CC-BY-4.0, code MIT ([github/docs](https://github.com/github/docs)). **The regexes are not published.** |
| Vendor into AGPL-3.0? | Yes. FSF lists Expat/MIT as GPL-compatible ([license-list#Expat](https://www.gnu.org/licenses/license-list.html#Expat)) | Yes, same basis | Yes. FSF: Apache-2.0 is compatible with GPLv3 ([#apache2](https://www.gnu.org/licenses/license-list.html#apache2)), and AGPLv3 §13 permits combining with GPLv3. It is **not** compatible with GPLv2 (irrelevant here) | Yes, same license. Vendoring would still tie kaizen to AGPL permanently | Nothing to vendor. Only a list of token *types* (522 entries in `src/secret-scanning/data/pattern-docs/fpt/public-docs.yml`) |
| Attribution obligation | Keep the copyright line and MIT permission notice with the copied patterns | Same (MIT) | Apache §4: ship a copy of the license, keep copyright notices, **mark modified files** with a change notice, and carry any NOTICE file (none exists) | AGPL §4–5: keep notices, mark modifications with a date, license the result as AGPL | n/a |
| Format | One generated TOML file: `[[rules]]` with `regex`, `secretGroup`, `entropy`, `keywords`, per-rule `allowlists`, plus a global allowlist. Generated from Go code in `cmd/generate/config/` | Code. Each rule is a TS package with regex literals and JS logic (allowlists, variable-placeholder filters, private-key magic-byte check). Depends on `@textlint/regexp-string-matcher` | Code. Python plugin classes with `re.compile` lists. Some add logic, e.g. the JWT plugin base64-decodes and `json.loads` each part | Code. One Go package per detector (Go RE2 `regexp` + an HTTP **verification** call, e.g. `stripe.go` calls `api.stripe.com`) | Prose docs |
| Rule count | **222** `[[rules]]` (221 regex + 1 path-only) | **28** in preset-recommend (27 detectors + `filter-comments`), ~40 rule packages overall | **27** plugin modules (including `base.py`, `__init__.py`, and keyword/entropy/IP plugins) | **~886** directories under `pkg/detectors` (not all are detectors; unverified exact number) | 522 secret types |
| Plain regex usable in Node 20 | **183 of 221 compile on Node 22** (78 as-is, 105 after stripping a leading `(?i)` into the `i` flag). 38 fail (see §2) | Nearly all are already JS regex literals, but each rule also has logic around it that you would have to port | Regex bodies port easily. Entropy/keyword/JWT plugins are code | Regex bodies are RE2 and port like gitleaks, but copying ~800 detectors is impractical and the verification logic is useless to kaizen | 0 |
| Maintenance | Very active, and the de-facto reference set. Rules include `keywords` prefilters | Active, JS-native, small and precise | Stale (last release May 2024) | Very active | n/a |

Counts in the gitleaks row come from parsing `gitleaks.toml` and calling `new RegExp()` on each rule (script: §6). I tested on Node 22.22.3 because Node 20 was not installed. Node 22 has no RegExp modifiers, so it stands in for Node 20 on this point. Node 20 itself is unverified.

## 2. Go RE2 vs JS RegExp: what breaks when porting

Syntax differences found in `gitleaks.toml`:

1. **Leading `(?i)`** (114 rules). JS has no whole-pattern inline flag. Strip it and pass the `i` flag. This is mechanical and safe.
2. **Mid-pattern `(?i)`** (e.g. `dp\.pt\.(?i)[a-z0-9]{43}`, `LTAI(?i)…`, `SG\.(?i)…`). In RE2 this turns on case-insensitivity from that point to the end. JS has no equivalent before RegExp modifiers, which are ES2025 ([TC39 proposal](https://github.com/tc39/proposal-regexp-modifiers)). They compile on Node 25.8.2 but **not on Node 22**, so not on Node 20 either. The exact Node version that shipped them is unverified; it is believed to be Node 23 / V8 12.5. Port by hand: widen the classes after the flag (`[a-z0-9]` → `[a-zA-Z0-9]`). Most such rules only need that.
3. **Modifier groups `(?i:…)` / `(?-i:…)`** (9 and 11 occurrences). Same Node-version problem. `generic-api-key` uses `(?-i:[Aa]pi|API)`.
4. **Python-style named groups `(?P<name>…)`** (`jwt-base64`). Rewrite as `(?<name>…)`.
5. **Silent mis-ports.** These compile in JS but mean something else:
   - `\z` (end of text, 6 rules: `openai-api-key`, `sentry-*`, `openshift-user-token`, …). Without the `u` flag, JS reads it as a literal `z`. Use `$` without the `m` flag.
   - `[[:alnum:]]` (1 rule). JS reads it as a character class of `[:alnum` followed by a literal `]`. Use `[A-Za-z0-9]`.
   - A generator must reject these tokens rather than trust `new RegExp()` succeeding.
6. **Performance.** RE2 guarantees linear time and has no backreferences or lookaround ([RE2 syntax](https://github.com/google/re2/wiki/Syntax)), so gitleaks rules never use them. JS is a backtracking engine. Rules with nested lazy quantifiers (`curl-auth-header`: `(?:.*?|.*?(?:[\r\n]{1,2}.*?){1,5})`) and `generic-api-key` (`[\w.-]{0,50}?…`) can go super-linear on long lines. Mitigations: exclude those rules, use gitleaks' `keywords` as a cheap `includes()` prefilter before running a regex (221/222 rules have keywords), and cap line length.

JS features that are safe on Node 20: lookbehind, named groups `(?<n>)`, `\p{…}` with `u`, and the `v` flag. secretlint's rules use `(?<!\p{L})…/gu`, which Node 20 handles.

## 3. False positives

Measured by running the compilable gitleaks rules (regex + `keywords` prefilter + per-rule `entropy` on the secret group) over a benign 6.9 MB corpus: npm's bundled source and docs, 1,475 `.js/.md/.json` files, with test dirs excluded.

| Rule set | Raw matches | After entropy threshold |
|---|---|---|
| 183 Node-22-compilable rules (all prefix/structure-anchored; `generic-api-key` excluded because it doesn't compile) | **0** | **0** |
| + `generic-api-key` (Node 25, modifiers supported) | 224 | **80** (e.g. `ecdsa-sha2-nistp256`) |

A canary file with a fake `ghp_…`, `AKIA…` and `xoxb-…` produced exactly those 3 hits, so the harness works. I didn't apply gitleaks' global/stopword allowlists, so real gitleaks would report fewer than 80 generic hits. The FP ratio still holds: nearly all of it comes from the keyword-context generic rule, and almost none from prefixed rules.

Caveats for transcripts (unmeasured):

- Transcripts hold commit SHAs, UUIDs, base64 blobs, hashes and minified code. Prefixed rules ignore them. Generic and entropy rules flag them.
- Rules with low `entropy` (2–3) are fine only because the prefix already carries the precision.
- Vendor-documented example keys (`AKIAIOSFODNN7EXAMPLE`) *will* be redacted. That's acceptable for a scrubber.
- Direction of error: **for a scrubber, a false positive costs a `[REDACTED:…]` in a summary and a false negative leaks a credential to the model.** kaizen can therefore tolerate more FPs than a CI linter, just not so many that summaries become unreadable.

## 4. Is entropy needed?

- **Not as a standalone detector.** detect-secrets' `Base64HighEntropyString` (default limit 4.5) and `HexHighEntropyString` (default 3.0) ([high_entropy_strings.py](https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/plugins/high_entropy_strings.py)) fire on every hash, SHA, UUID and asset fingerprint. In a coding transcript that would redact commit IDs and file hashes the model needs.
- **Yes, as a post-filter on keyword-context rules only.** gitleaks attaches `entropy` to 130 of 222 rules. It matters for `generic-api-key` (3.5), where it cut matches 224 → 80. It is redundant for prefixed tokens like `ghp_`, `sk_live_` and `xoxb-`.
- Shannon entropy is ~10 lines of dependency-free JS, so supporting the field costs nothing.
- Recommendation: carry the `entropy` field through, apply it where present, and don't ship entropy-only scanning. If a generic `KEY=value` rule is wanted later, gate it behind entropy ≥ 3.5, a value length ≥ 16 and a stopword list.

## 5. Recommendation

**Adopt gitleaks as the upstream. Generate a curated `patterns.mjs` from it. Add secretlint-derived and in-house rules for the gaps.**

Why gitleaks:

- MIT, so vendoring is trivial.
- Its data is a single declarative file, not code.
- It has the broadest actively maintained coverage.
- 83% of its rules compile in Node 20 after one mechanical transform, and most of the rest need only class widening.
- Its `keywords`, `secretGroup` and `entropy` fields map directly to a zero-dependency JS matcher.

Why not the others:

- **secretlint.** Excellent precision and already JS, but it is code-per-rule with a runtime dependency and has only 27 detectors. Borrow its *patterns* (MIT) for DB connection strings and basic-auth URLs.
- **detect-secrets.** Stale. Its value is entropy plugins, which are the wrong tool here.
- **trufflehog.** Built around live verification (HTTP calls). Porting ~800 Go detectors is out of scope.
- **GitHub.** No public regexes. Use it only as a checklist of token types, together with the published token-format design ([GitHub blog: token formats](https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/): `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` prefixes + CRC32 checksum).

Vendoring mechanics:

- Pin a gitleaks tag.
- Keep a small generator script that:
  1. drops a rule list (`generic-api-key`, `curl-auth-*`, path-only rules);
  2. strips leading `(?i)`;
  3. rejects `\z`, `[[:…:]]`, `(?P<`, and mid-pattern or modifier groups unless the rule is hand-patched;
  4. emits `{id, re, secretGroup, entropy, keywords}`.
- Put the MIT notice for gitleaks (and secretlint, if its patterns are used) in a header comment and in `THIRD_PARTY_NOTICES`.

### Minimal must-cover token families

Sources are gitleaks rule IDs, except where secretlint or kaizen is named.

| Family | Source rules | Notes |
|---|---|---|
| AWS | `aws-access-token` (`(A3T…|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}`) | The 40-char secret access key has no prefix, so it needs context (`aws_secret_access_key\s*[=:]`). secretlint-rule-aws has a context rule |
| GCP / Azure | `gcp-api-key` (`AIza…`), `azure-ad-client-secret` | GCP service-account JSON is caught by the private-key rule (`"private_key": "-----BEGIN…`) |
| GitHub | `github-pat`, `github-fine-grained-pat`, `github-oauth`, `github-app-token`, `github-refresh-token` | Prefix-based, very low FP |
| GitLab | `gitlab-pat`, `gitlab-pat-routable`, `gitlab-ptt`, `gitlab-rrt`, `gitlab-runner-*`, `gitlab-deploy-token`, … (15 rules) | |
| Slack | `slack-bot-token`, `slack-user-token`, `slack-app-token`, `slack-webhook-url`, `slack-config-*`, `slack-legacy-*` | |
| Stripe | `stripe-access-token` (`sk_/rk_` live/test) | |
| AI providers (kaizen's own context) | `anthropic-api-key`, `anthropic-admin-api-key`, `openai-api-key` (fix `\z`) | Most likely to appear in Claude Code transcripts |
| Package registries | `npm-access-token` | |
| Private keys | `private-key` (`-----BEGIN … PRIVATE KEY-----` block) | Redact from the BEGIN line even if the block is truncated, since transcripts often cut output |
| JWTs | `jwt` (`ey….ey….sig`) | Redact the whole token. Optionally confirm the base64 header decodes to JSON, as detect-secrets does, to cut noise |
| Connection strings | **not in gitleaks.** Port from secretlint-rule-database-connection-string: `(mongodb(\+srv)?|postgres(ql)?|(jdbc:)?mysqlx?|redis|amqp)://user:PASS@host` | Redact only the password group. Skip `${VAR}` placeholders, as secretlint does |
| Basic-auth URLs | secretlint-rule-basicauth: `https?://user:pass@host` | Same password-only redaction |
| TOTP seeds | **none of the candidates cover this.** Write it in-house: `otpauth://[th]otp/[^?\s]*\?[^\s]*\bsecret=([A-Z2-7]{16,}=*)` (case-insensitive) | Also consider bare base32 seeds next to a `totp`/`otp`/`2fa` keyword |

## 6. Method / reproducibility

- `gitleaks.toml` was fetched from `master`. Rules were split on `[[rules]]`, the `regex`/`entropy`/`keywords`/`secretGroup` fields extracted, and each regex compiled with `new RegExp` on Node 22.22.3 and 25.8.2.
- FP probe: same rules over `~/.nvm/versions/node/v22.22.3/lib/node_modules/npm`, with the keywords prefilter and a Shannon entropy post-filter on the secret group.
- Scripts were run ad hoc and not committed.
- **Unverified:** behaviour on Node 20 exactly (inferred from Node 22), the trufflehog detector count (directory count), the FP rate on real transcripts, and the Node version that shipped RegExp modifiers.

## Implications for kaizen

- Add `skills/kaizen/scripts/patterns.mjs`, generated from a pinned gitleaks tag by a checked-in generator, with an MIT attribution header and a `THIRD_PARTY_NOTICES` entry. No runtime dependency and no TOML parser at runtime.
- Only prefix/structure-anchored rules at first. Drop `generic-api-key`, `curl-auth-*` and entropy-only scanning. Tests should assert that SHAs and UUIDs pass through untouched.
- The generator must fail on RE2-only syntax (`\z`, POSIX classes, `(?P<`, mid-pattern `(?i)` and modifier groups) instead of silently mis-porting. Hand-patch the families listed above.
- Matcher: keyword `includes()` prefilter → regex → optional entropy check on `secretGroup` → replace with `[REDACTED:<rule-id>]`. Cap line length to bound backtracking.
- Add in-house rules for connection-string passwords, basic-auth URLs and `otpauth://` TOTP seeds, plus a context rule for the AWS secret access key.
- Scrub before summarising: run over the raw transcript text (including tool outputs), not only over the rendered summary.
