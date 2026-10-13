---
title: skill-effectiveness
description: "Use when creating, reviewing or improving a native Vally A/B evaluation of whether an Agent Skill helps on a realistic task, including deriving a candidate skill from repository knowledge."
sidebar_position: 9
author: Microsoft
ms.date: 2026-10-13
ms.topic: reference
keywords:
  - skill
  - hve-core
  - skill-effectiveness
---

<!-- BEGIN AUTO-GENERATED: metadata -->
| Field       | Value                                                                                 |
|-------------|---------------------------------------------------------------------------------------|
| Kind        | skill                                                                                 |
| Source      | `.github/skills/hve-core/skill-effectiveness`                                         |
| Invocation  | Invoked directly as `/skill-effectiveness`, or loaded on demand by referencing agents |
| Interactive | No                                                                                    |
<!-- END AUTO-GENERATED: metadata -->

## What it does

<!-- BEGIN AUTO-GENERATED: overview -->
Use when creating, reviewing or improving a native Vally A/B evaluation of whether an Agent Skill helps on a realistic task, including deriving a candidate skill from repository knowledge.
<!-- END AUTO-GENERATED: overview -->

## When to use it

Use this supervised authoring workflow when you want to compare a realistic task
with and without a complete skill package. Start from an existing skill or derive
a source-grounded candidate from a repository, then use the same native Vally
comparison path.

The workflow helps select fair inputs and relevant executable, source-grounded,
or rendered-image evidence. It does not deliver an automatic adoption verdict,
enforce candidate isolation, or establish general effectiveness.

Authoring and model-free tests do not authorize paid execution. Candidate runs,
prompt graders, and image reviews require explicit scope, budget, and adequate
spending controls. The pinned runtime lacks the required hard credit cap.

## Example usage

```text
Use skill-effectiveness to author a baseline-versus-with-skill evaluation
for data-catalog on these public fixtures. Keep the task, model, tools, and
checks identical. Prepare native Vally files and evaluation notes only;
do not start candidates or model reviews.
```

For the repository-derived route:

```text
Inspect this pinned repository's extension contract. If its non-obvious
knowledge warrants a reusable skill, create a source-grounded candidate
outside the authoring package and propose a fair A/B task. Stop if no
candidate is defensible. Do not run paid evaluations.
```

Expected outputs include native eval and experiment YAML, public fixtures,
relevant task checks, a frozen focus skill, package configuration, and evaluation
notes. Preserve runtime failures and unavailable evidence separately from
measured task quality.
