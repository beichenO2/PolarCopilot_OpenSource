---
name: pc-os-yolo-confirm
description: >-
  Open Source YOLO alignment: goal, plan, Hub review. Trigger: "YOLO", "full auto", "alignment".
---

# PC-OS YOLO confirm

1. Clarify the user's **stretch goal** (not a task checklist).
2. Write alignment markdown with sections: 极限目标, 工作逻辑, 用户预期体验, 执行计划, 质量标准, 工作流测试矩阵, 风险.
3. `POST /api/ui/alignment` with `agent_id`, `goal`, `plan_markdown`, `sections`.
4. `send_prompt` — ask user to review on **YOLO** tab and approve.
5. On approve → `pc-os-yolo-execute`.

No external requirement database required; anchor on user text and repo README.
