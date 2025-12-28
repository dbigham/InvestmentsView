# Instructions for Agents

## General Principles

- DRY: Don't Repeat Yourself: Where possible, try to factor our repeated code and data.
  - When analyzing bugs, or implementing features, if you come across significant chunks of code/functionality that are duplicated or similar enough that they should probably be unified / generalized, please bring things things to my attention.
- Avoid using short forms for variable names and function names. For example, favor "accountTotal" over "accountTot", generally avoid single-character variable names, etc. Treat variable names and function names as self-documenting, so that if someone were to read the name without context, they'd have a good shot at understanding what it is.
- Try to implement functionality in a way that it can unit tested and run/debugged via the CLI. (If functionality _requires_ the UI to be used, then it's harder to unit test, and harder for an LLM agent to debug later.)
- Avoid fixing bugs with solutions that are technically incorrect, or which skip understanding the root problem in favor of an ugly workaround.

## Fixing Bugs

Any time you are asked to fix a bug, please always first try to reproduce the issue via CLI.

Then, try debug/fix the issue.

And finally, verify your fix via the CLI.

If the bug looks to be fixed, then hopefully it's possible to add a good unit test.

## Unit Tests

Ideally all core functionality and all bug fixes are unit tested.

Unit tests should have a comment above them that tries to describe the "why" / expected value from first principles so that someone looking at the test later can understand the importance of the test, and why the outputs are expected to be what they are, even though they weren't the one to write the test.

## Git Commit Comments

When making git commits for bug fixes, the comment should try to specify:

- What the observed issue was, including whether we were able to reproduce via CLI and how.
- What we discovered when we debugged the code.
- The fix we went with. If there was another potential solution, and we weren't sure which was best, then we could describe that other potential solution and why we went with our solution.
- Whether we were able to verify the solution via CLI, and what the new output was.
- Any unit tests we added.