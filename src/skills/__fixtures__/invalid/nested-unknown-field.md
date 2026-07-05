---
name: nested-unknown-field-skill
description: Unknown key inside a sub-object must be rejected.
version: 1.0.0
trigger:
  keywrods: [typo]
---

# Nested unknown field

The `keywrods` typo above must be caught by the nested additionalProperties gate.
