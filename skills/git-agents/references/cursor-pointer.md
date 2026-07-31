# Cursor pointer rule

Cursor has no global instructions file (its User Rules live in the app's settings), so git-agents does not generate one. The opt-in bridge is a one-time manual User Rule that makes Cursor's agent read the canonical file at runtime.

Run `npx -y git-agents@latest --internal install-pointer-docs` to print the rule text with the exact resolved path, then walk the user through it:

1. Open Cursor Settings, then Rules, then User Rules.
2. Add a new rule and paste the printed text.
3. Done: every Cursor session will read the canonical instructions (and the cursor overlay, when one exists) from the git-agents clone.

Notes for the conversation:

- This is per machine, not synced by Cursor; repeat it on each machine.
- The rule survives `ga` syncs because it points at the clone, not at a generated copy.
- Revisit when Cursor ships native global AGENTS.md support; the pointer rule then becomes unnecessary.
