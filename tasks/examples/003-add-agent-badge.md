---
id: 003-add-agent-badge
title: Add a "maintained by agents" badge to the README
targets: [all]
scope: [README.md]
risk: drudgery
why: Repos maintained by the agent fleet should say so at the top of their README.
---

## End state

- The repository's `README.md` contains, directly under the top-level `#`
  heading, this exact line (followed by a blank line):

  ```markdown
  ![maintained-by-agents](https://img.shields.io/badge/maintained%20by-agents-blueviolet)
  ```

- Nothing else in the README changes.

## Preconditions

- Only act if `README.md` exists and does not already contain
  `maintained%20by-agents`. If the badge is already present, or there is no
  README, make no changes and end your reply with exactly: `NO_CHANGES_NEEDED`

## Examples

```diff
 # demo-ts-service
+
+![maintained-by-agents](https://img.shields.io/badge/maintained%20by-agents-blueviolet)

 A small demo service.
```

## Verification

Call the `verify` tool after making your changes. The task is only complete
when `verify` reports success.

## Scope

Only add the badge line. Do not rewrap, reformat, or edit any other part of
the README or any other file.
