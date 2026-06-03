# Notice

This Pi package vendors Fast Context core files adapted from:

- Repository: https://github.com/oulkurt/fast-context-skill
- Runtime source copied from: `scripts/lib/*`
- License: MIT, preserved in `LICENSE`

`fast-context-skill` itself is an Agent Skill and CLI adaptation of:

- Repository: https://github.com/SammySnake-d/fast-context-mcp
- Upstream version noted by fast-context-skill: `v1.3.0-beta.2`
- Upstream commit noted by fast-context-skill: `af65ce77a408656c815444397ef6892c47a96c0a`
- Upstream license: MIT, preserved at `src/lib/LICENSE.fast-context-mcp`

This package does not use the MCP server wrapper or the CLI wrapper as its primary runtime. It registers Pi native tools and commands through a TypeScript extension and calls the vendored core directly.
