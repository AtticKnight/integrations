# Agent instructions

## Commit messages and releases

Use Conventional Commit subjects for changes in this repository. On `main`, semantic-release calculates one shared npm version for the Atto CLI, wallet MCP, and Marketplace MCP from commits since the last `atto-v*` tag.

- Use `fix:` for patch releases and `feat:` for minor releases. Optional scopes such as `fix(marketplace-mcp):` are supported.
- Include a `BREAKING CHANGE:` footer for breaking changes that require a major release.
- Use `docs:`, `chore:`, or `refactor:` for routine work that can ship with a later release.
