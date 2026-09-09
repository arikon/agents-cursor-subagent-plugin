# Noninteractive ACP authentication and shared auth-file collision

Verified by read-only installed-source inspection on 2026-09-09. No auth operation was invoked for this inspection.

Pinned Cursor `2026.08.25-3e8eec8` (`4943.index.js`) and currently installed `2026.09.08-6caf4ff` (`7578.index.js`, onboarding in `9320.index.js`) have the same relevant flow:

- `run.ts` computes the login check unconditionally, then ORs auth-token authentication, explicit `--api-key`/`CURSOR_API_KEY` presence and the login result. This is not a short-circuit around the login check.
- `onboarding.tsx` LOGIN check reads credentials. An invalid/expiring-soon access token returns false. Otherwise, a truthy stored `apiKey` makes it call `clearAuthentication()` and return false, even if access/refresh tokens are present. Without a key, it accepts access plus refresh tokens. Read errors return false.
- `auth-refresh.ts` defines expiring-soon as invalid JWT, absent/nonfinite expiry, or expiry less than 300 seconds away.
- File credential manager `clearAuthentication()` retains only Bedrock credentials if present; otherwise it unlinks the auth file. It resets cached access/refresh/API-key values.
- ACP `authenticate(cursor_login)` repeats the LOGIN check. False starts a browser login, waits for its result and stores credentials. Its sole advertised method is not a passive credential check.
- `session/new` and `session/load` accept authentication already established by startup. Calling authenticate is not required when that startup state is authenticated.

Both versions' `index.js` explicitly support `AGENT_CLI_CREDENTIAL_STORE=memory`. The memory credential manager reads/writes only its in-process fields. API-token refresh supports `CURSOR_API_KEY` when this store is initially empty; its token persistence therefore remains in memory.

The minimal adapter repair reads the selected auth file once per startup, clones the child environment, and, when a nonblank file API key exists, supplies `CURSOR_API_KEY`, selects the memory credential store and removes inherited `CURSOR_AUTH_TOKEN`. The key is not put in argv. The version probe uses the same prepared environment. ACP proceeds directly from initialize to new/load, with no interactive authenticate call. Missing file/key retains native credential startup; malformed/unreadable auth fails before spawn. There is no login/refresh implementation in the MCP, credential copying/restoration, auth-file write or new credential registry. Discovery continues to require the same file API key.

This establishes source-level causality and the supported repair boundary. It does not identify the process that opened any particular browser window or prove a live authenticated launch. Deterministic launch fixtures verify child environment, absence of authenticate, file preservation and failure cleanup separately from a live canary.
