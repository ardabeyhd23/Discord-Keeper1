FR Family Shop text command
============================
Owner Discord ID: 1231243551053053982

The requested behavior is:
- `/shop` remains available.
- Owner can type exactly `shop` (lowercase) to open the same Shop GUI.
- Other users typing `shop` are ignored.
- The `shop` message is deleted after triggering.

This file is included because the current project source did not expose a safe messageCreate/openShop hook that could be patched automatically without risking the existing shop flow.
