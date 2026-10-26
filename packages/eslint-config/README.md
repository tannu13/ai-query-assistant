# `@repo/eslint-config`

Shared ESLint configuration, consumed by the workspaces as `@repo/eslint-config/<name>`.

| Entry | Used by | Adds |
| --- | --- | --- |
| `base` | `apps/backend`, `packages/shared` | TypeScript, import ordering, Prettier compatibility |
| `react-internal` | `apps/web` | browser globals and `eslint-plugin-react-hooks` |
| `next` | — | unused; retained from the scaffold |

Two things worth knowing before trusting a green `lint`:

- **`eslint-plugin-only-warn` downgrades every rule to a warning**, so `turbo run lint` exits 0 whatever it finds. Remove it from `base.js`, or pass `--max-warnings=0`, to make lint able to fail a build.
- **`lint` is the one task that needs Node ≥ 24** (`nvm use` first). Everything else in this repo runs under Bun alone. See the root README's note on Node.
