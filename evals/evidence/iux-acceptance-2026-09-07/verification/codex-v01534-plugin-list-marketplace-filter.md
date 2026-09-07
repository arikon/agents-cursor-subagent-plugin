# Codex 0.153.4 marketplace-filter proof

Date: 2026-09-07

- Installed executable: `/Applications/ChatGPT.app/Contents/Resources/codex`
- Observed version: `codex-cli 0.153.4`
- Primary CLI help exposes `plugin list --marketplace <MARKETPLACE> --json` and describes the unfiltered command as listing plugins from configured and remote marketplaces.
- Fresh isolated authenticated `CODEX_HOME`: `plugin list --marketplace codex-cursor-subagent-plugin --json` exited `0` in `0.01s`, with `installed=0` and `available=0`.
- Completed isolated fixture with the managed local marketplace installed: the same filtered command exited `0` in `0.02s`, with `installed=1` and `available=0`; the returned registration had the expected marketplace id, local source path, and installed manifest version.
- Fresh isolated unfiltered comparison: `plugin list --json` exited `0` in `11.21s` and returned unrelated remote marketplace registrations. During a diagnostic timeout, the same unfiltered command remained nearly CPU-idle with two established HTTPS connections until the adapter's 60-second bound.

No global plugin or Codex configuration was changed. Each fresh proof used a temporary isolated home; temporary credential copies were removed after inspection.
