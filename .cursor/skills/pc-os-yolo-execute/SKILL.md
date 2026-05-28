---
name: pc-os-yolo-execute
description: >-
  Open Source: after YOLO approval, implement with bounded retry loop. Trigger: alignment approved.
---

# PC-OS YOLO execute

- **Pass** = matches approved stretch goal (not checkbox completion).
- Inner loop: edit → verify (tests/build in repo).
- Outer loop: up to 7 rounds; refresh from alignment doc each round (do not paste prior error dumps as the new prompt).
- Report via `send_prompt` + `check_hub` when batch done or blocked.
