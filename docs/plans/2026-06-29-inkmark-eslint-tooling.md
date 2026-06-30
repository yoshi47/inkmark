# ESLint + Prettier + tsconfig Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a maximally-strict, type-aware lint/format toolchain (ESLint flat config + Prettier + perfectionist import sorting + tsconfig hardening + lefthook pre-commit) to inkmark so code quality is enforced by *rules*, not by AI prompting.

**Architecture:** ESLint (flat config, v9) owns *correctness/style rules*; Prettier owns *formatting*; `eslint-config-prettier` removes the overlap. typescript-eslint runs in full type-aware mode (`strictTypeChecked` + `stylisticTypeChecked`) plus every high-friction type-aware rule turned on. Type-aware linting is wired through a **solution-style root `tsconfig.json` with project references** (`tsconfig.node.json` for server/cli/rfm under NodeNext, `tsconfig.web.json` for the React/Vite SPA under Bundler) so each area is type-checked under its *correct* module resolution and tests are covered. perfectionist auto-sorts imports with **no blank lines between them**. tsconfig gains every strict flag plus `erasableSyntaxOnly` to ban non-erasable legacy TS syntax (enum / namespace-with-runtime / parameter properties / `import =`). lefthook keeps pre-commit fast (lint+format on staged files) and runs whole-project `tsc` on pre-push.

**Tech Stack:** ESLint 9, typescript-eslint 8, Prettier 3, eslint-plugin-perfectionist 4, eslint-plugin-import-x 4, eslint-plugin-react ≥7.37 / react-hooks 5 / react-refresh / jsx-a11y ≥6.10, @vitest/eslint-plugin, lefthook, pnpm, TypeScript ≥5.8.

## Global Constraints

- **Decisions locked with the user (2026-06-29):**
  - Formatter = **ESLint + Prettier** (not ESLint-only, not Biome).
  - Imports = **perfectionist full auto-sort + grouping**, `newlinesBetween: 'never'` (no blank lines between imports — the user's explicit request).
  - Type-aware rules = **full maximum strength, web included, no relaxations** — `strict-boolean-expressions` (with **all `allow*` options set to `false`**), `no-unnecessary-condition`, `explicit-function-return-type` all fully on. Rationale: code is written from scratch, so there is no legacy to retrofit.
  - Ban legacy/compat TS syntax (enum etc.) at both the **compiler** (`erasableSyntaxOnly`) and **lint** (`no-restricted-syntax` / `no-namespace`) layers.
- **Node / React versions are explicitly out of scope** for this plan (user will revisit separately). Do **not** change `engines`, the Node floor, or React/dependency versions here. (Background for the revisit: Node 20 is EOL as of 2026-04; difit already pins Node 24.)
- **TypeScript must be ≥5.8** — both `erasableSyntaxOnly` and `noEmit` in `tsc --build` mode require it. The v1 scaffold pins `typescript@^5.7`; this plan bumps it to `^5.9`.
- **ESM project** — `package.json` has `"type": "module"`; all config files use ESM syntax.
- **Package manager = pnpm** (matches v1 plan and difit).
- **This plan supersedes the v1 plan's tsconfig step.** The v1 implementation plan (`docs/plans/2026-06-29-inkmark-v1-implementation.md`, Steps 2–3) defines a single `tsconfig.json` (node) + `tsconfig.web.json`. This plan **replaces** that with a references layout (root solution + `tsconfig.node.json` + `tsconfig.web.json` + `tsconfig.build.json`) and updates the affected `package.json` scripts (`typecheck`, `build:server`). When you later execute the v1 plan, use the tsconfig + scripts defined **here** and skip v1 Steps 2–3.

## Why this design (answering the two failure modes a naive setup hits)

1. **Type-aware linting must resolve each file under its own tsconfig.** `projectService: true` routes every file to its owning project via the **solution root's references** (exactly how an editor/tsserver does it, and the standard Vite layout). A single catch-all `tsconfig.eslint.json` does **not** work: `projectService` only auto-discovers files literally named `tsconfig.json`, and a catch-all would also type-check web files under the node module-resolution, breaking Bundler-only imports (`*.css`, `import.meta.env`, extensionless paths) → unresolved → `any` → a `no-unsafe-*` false-positive storm. References avoid both.
2. **Tests must belong to a project** or type-aware lint hard-errors on them. The leaf configs `include` tests; emit is done by a separate `tsconfig.build.json` that excludes them.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `package.json` | devDeps; scripts: `lint`/`lint:fix`/`format`/`format:fix`/`typecheck`/`build:server`; `typescript` → `^5.9` | 0/1/2/3/6 |
| `tsconfig.json` | **solution root** — `files: []` + `references` to node & web; ESLint + `tsc -b` entry point | 1 |
| `tsconfig.node.json` | server/cli/rfm **+ their tests**, NodeNext, `composite`, `noEmit`, + hardening | 1 |
| `tsconfig.web.json` | React SPA `src/web` **+ tests**, Bundler/DOM/jsx, `composite`, `noEmit`, references node, + hardening | 1 |
| `tsconfig.build.json` | server emit only — extends node, emits to `dist`, excludes tests + web | 1 |
| `.prettierrc.json` | Prettier formatting options (mirrors difit's settings) | 2 |
| `.prettierignore` | paths Prettier skips | 2 |
| `eslint.config.mjs` | flat config: base → type-aware → import → perfectionist → React(`src/web`) → vitest(tests) → scoped overrides → **prettier last** | 3,4,5,6 |
| `lefthook.yml` | pre-commit (staged `eslint --fix` then `prettier --write`, sequential) + pre-push (`tsc -b`) | 6 |

**Why `eslint.config.mjs` (not `.ts`):** avoids the `jiti` dependency and the chicken-and-egg of type-aware-linting the config itself. `tseslint.config()` still gives full type hints inside `.mjs`.

---

## Task 0 (conditional): Bootstrap a minimal lintable scaffold

> **Skip this entire task if the v1 scaffold (package.json + src/) already exists.** If you run it, when you later execute the v1 plan, **merge** its dependency list into this `package.json` (don't overwrite) and use the tsconfigs from Task 1.

**Files:**
- Create: `package.json`, `src/rfm/sample.ts`

- [ ] **Step 1: Create a minimal `package.json`**

```json
{
  "name": "inkmark",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {},
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.9.0"
  }
}
```

- [ ] **Step 2: Create a sample source file so the linter has something to check**

```ts
// src/rfm/sample.ts
export function greet(name: string): string {
  return `hello ${name}`;
}
```

- [ ] **Step 3: Install**

Run: `pnpm install`
Expected: install succeeds, `node_modules/` created.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml src/rfm/sample.ts
git commit -m "🧱 chore: minimal scaffold for lint setup"
```

---

## Task 1: tsconfig — references layout + compiler hardening + ban legacy syntax

**Files:**
- Create: `tsconfig.json` (solution), `tsconfig.node.json`, `tsconfig.web.json`, `tsconfig.build.json`
- Modify: `package.json` (bump `typescript` → `^5.9.0`; add `typecheck` + `build:server` scripts)

**Interfaces:**
- Produces: a TS project graph where (a) every strict flag is on, (b) non-erasable legacy syntax fails to compile, (c) `projectService` can route every file (incl. tests, incl. web-under-Bundler) to the correct project via the solution root.

**Shared hardening block** (referenced by the configs below — apply the *same* options to both `tsconfig.node.json` and `tsconfig.web.json`):

```jsonc
// --- strict + hardening (identical in node & web leaf configs) ---
"strict": true,
"noUncheckedIndexedAccess": true,
"exactOptionalPropertyTypes": true,
"noImplicitOverride": true,
"noImplicitReturns": true,
"noFallthroughCasesInSwitch": true,
"noPropertyAccessFromIndexSignature": true,
"allowUnreachableCode": false,
"allowUnusedLabels": false,
"forceConsistentCasingInFileNames": true,
"verbatimModuleSyntax": true,
"isolatedModules": true,
"erasableSyntaxOnly": true,
"skipLibCheck": true
```

> **Note on unused locals/params:** we deliberately do **not** set `noUnusedLocals`/`noUnusedParameters` here — `@typescript-eslint/no-unused-vars` (Task 3) covers it, is auto-fixable, and supports an `_`-prefix escape, without `tsc` erroring on work-in-progress code mid-edit.
> `erasableSyntaxOnly` (TS ≥5.8) bans `enum`, runtime `namespace`/`module`, `import x = require()`, and parameter properties. `verbatimModuleSyntax` forces `import type` discipline (pairs with the lint rule in Task 3). `verbatimModuleSyntax` + the v1 `esModuleInterop: true` is safe (orthogonal; project is pure ESM).

- [ ] **Step 1: Bump TypeScript** in `package.json` devDependencies to `"typescript": "^5.9.0"`, then `pnpm install`.

- [ ] **Step 2: Create `tsconfig.json` (solution root)**

```jsonc
{
  // Solution-style root: no files of its own; just references the leaf projects.
  // Used by ESLint's projectService AND by `tsc -b` for whole-project typecheck.
  "files": [],
  "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }]
}
```

- [ ] **Step 3: Create `tsconfig.node.json`** (server / cli / rfm + their tests)

```jsonc
{
  "compilerOptions": {
    "composite": true,
    "noEmit": true,
    "tsBuildInfoFile": "./node_modules/.cache/tsc/node.tsbuildinfo",
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "esModuleInterop": true,
    // + paste the shared hardening block here
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "erasableSyntaxOnly": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["src/web", "dist", "node_modules"]
}
```

- [ ] **Step 4: Create `tsconfig.web.json`** (React SPA + tests; Bundler resolution; references node so it can import `rfm`)

```jsonc
{
  "compilerOptions": {
    "composite": true,
    "noEmit": true,
    "tsBuildInfoFile": "./node_modules/.cache/tsc/web.tsbuildinfo",
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "allowImportingTsExtensions": true,
    "esModuleInterop": true,
    // + paste the shared hardening block here (same as node)
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "erasableSyntaxOnly": true,
    "skipLibCheck": true
  },
  "references": [{ "path": "./tsconfig.node.json" }],
  "include": ["src/web"],
  "exclude": ["dist", "node_modules"]
}
```

> `src/rfm` stays solely in the node project (single membership, NodeNext). The web project imports it via the project **reference**, so there is no dual-membership ambiguity for the linter.

- [ ] **Step 5: Create `tsconfig.build.json`** (server emit only)

```jsonc
{
  "extends": "./tsconfig.node.json",
  "compilerOptions": {
    "composite": false,
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true,
    "tsBuildInfoFile": null
  },
  "exclude": ["src/web", "dist", "node_modules", "**/*.test.ts", "**/*.test.tsx"]
}
```

- [ ] **Step 6: Set scripts** in `package.json`:

```json
"typecheck": "tsc -b",
"build:server": "tsc -p tsconfig.build.json"
```

> `tsc -b` builds the solution (both leaf projects, in dependency order, type-only via `noEmit`) and caches via `.tsbuildinfo` so repeat runs are fast. (`tsc -b` + `noEmit` requires TS ≥5.6; we use ≥5.8.) The v1 plan's `typecheck`/`typecheck:web`/`build:server` are replaced by these two.

- [ ] **Step 7: Verify the compiler rejects an enum (proves `erasableSyntaxOnly`)**

Temporarily add to `src/rfm/sample.ts`: `export enum E { A }`
Run: `pnpm typecheck`
Expected: FAIL with TS1294 (`This syntax is not allowed when 'erasableSyntaxOnly' is enabled`). Remove the enum afterward.

- [ ] **Step 8: Verify clean typecheck**

Run: `pnpm typecheck`
Expected: PASS on the cleaned sample.

- [ ] **Step 9: Commit**

```bash
git add tsconfig.json tsconfig.node.json tsconfig.web.json tsconfig.build.json package.json pnpm-lock.yaml
git commit -m "🔧 chore: tsconfig references layout + hardening + ban non-erasable syntax"
```

---

## Task 2: Prettier

**Files:**
- Create: `.prettierrc.json`, `.prettierignore`
- Modify: `package.json` (add `prettier` devDep + `format`/`format:fix` scripts)

- [ ] **Step 1: Add Prettier**

Run: `pnpm add -D prettier@^3`

- [ ] **Step 2: Create `.prettierrc.json`** (mirrors difit's settings for cross-repo consistency)

```json
{
  "singleQuote": true,
  "jsxSingleQuote": false,
  "trailingComma": "all",
  "semi": true,
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "arrowParens": "always",
  "bracketSpacing": true,
  "endOfLine": "lf"
}
```

- [ ] **Step 3: Create `.prettierignore`**

```
dist
coverage
node_modules
pnpm-lock.yaml
*.md
```

> `*.md` is ignored so Prettier never reflows the design/plan docs (hard one-sentence-per-line wrapping). Remove that line later if you want Markdown formatted.

- [ ] **Step 4: Add scripts** to `package.json`:

```json
"format": "prettier --check .",
"format:fix": "prettier --write ."
```

- [ ] **Step 5: Verify**

Run: `pnpm format:fix && pnpm format`
Expected: second command exits 0 (clean).

- [ ] **Step 6: Commit**

```bash
git add .prettierrc.json .prettierignore package.json pnpm-lock.yaml
git commit -m "🎨 chore: add Prettier"
```

---

## Task 3: ESLint flat config — base + full type-aware + scoped no-console + legacy bans

**Files:**
- Create: `eslint.config.mjs`
- Modify: `package.json` (ESLint + typescript-eslint + globals devDeps; `lint`/`lint:fix` scripts)

**Interfaces:**
- Produces: a runnable `pnpm lint` covering all `.ts`/`.tsx` with full type-aware rules. Import/React/vitest layers are appended in Tasks 4–6 to the **same** `tseslint.config(...)` array, with the `prettier` entry kept strictly **last**.

- [ ] **Step 1: Add ESLint core deps**

Run: `pnpm add -D eslint@^9 @eslint/js@^9 typescript-eslint@^8 globals@^15 eslint-config-prettier@^10`

- [ ] **Step 2: Create `eslint.config.mjs`** (base layer)

```js
// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';

export default tseslint.config(
  // --- global ignores ---
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '**/*.d.ts'] },

  // --- base JS + full type-aware TS ---
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // --- enable the type-aware parser via the solution root + references ---
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
  },

  // --- full-strength extras (the rules the user explicitly opted into) ---
  {
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        {
          allowString: false,
          allowNumber: false,
          allowNullableObject: false,
          allowNullableBoolean: false,
          allowNullableString: false,
          allowNullableNumber: false,
          allowNullableEnum: false,
          allowAny: false,
        },
      ],
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-console': 'error',

      // --- ban legacy / compat syntax at the lint layer too ---
      '@typescript-eslint/no-namespace': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message: 'enum は禁止。`const X = {...} as const` + union 型を使う。',
        },
      ],
    },
  },

  // --- scoped no-console exceptions: the CLI's job IS stdout; server logs errors ---
  {
    files: ['src/cli/**/*.{ts,tsx}'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['src/server/**/*.{ts,tsx}'],
    rules: { 'no-console': ['error', { allow: ['warn', 'error'] }] },
  },

  // --- config files: not part of any tsconfig → disable type-aware ---
  {
    files: ['**/*.config.{js,mjs,ts}'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // --- MUST BE LAST: turn off rules Prettier handles ---
  prettier,
);
```

> `strict-boolean-expressions` is at **true maximum** (every `allow*: false`) per the user's decision — expect real friction in `src/web` (nullable `string|undefined` conditions in form/error rendering, the `{count && <X/>}` footgun) and at parse boundaries in `src/rfm`. Resolve with code (narrow explicitly), not by weakening the rule.

- [ ] **Step 3: Add scripts** to `package.json`:

```json
"lint": "eslint .",
"lint:fix": "eslint . --fix"
```

- [ ] **Step 4: Verify the linter runs and is type-aware**

Run: `pnpm lint`
Expected: 0 errors on the clean sample. To prove type-awareness, temporarily add to `src/rfm/sample.ts`:
```ts
export function bad() { Promise.resolve(); }
```
Run `pnpm lint` → Expected: errors include `@typescript-eslint/no-floating-promises` and `@typescript-eslint/explicit-function-return-type`. Remove afterward.

- [ ] **Step 5: Verify the enum lint ban**

Temporarily add `enum E { A }` to a `.ts` file, run `pnpm lint` → Expected: `no-restricted-syntax` error with the Japanese message. Remove afterward.

- [ ] **Step 6: Commit**

```bash
git add eslint.config.mjs package.json pnpm-lock.yaml
git commit -m "🔧 chore: ESLint flat config with full type-aware rules + legacy bans"
```

---

## Task 4: Import sorting (perfectionist) + import hygiene (import-x)

**Files:**
- Modify: `eslint.config.mjs` (add perfectionist + import-x blocks **before** the `prettier` entry)
- Modify: `package.json` (devDeps)

- [ ] **Step 1: Add deps**

Run: `pnpm add -D eslint-plugin-perfectionist@^4 eslint-plugin-import-x@^4 eslint-import-resolver-typescript@^3.7`

- [ ] **Step 2: Add the import blocks** to `eslint.config.mjs`.

Add imports at the top (top-level, no inline `await import`):
```js
import perfectionist from 'eslint-plugin-perfectionist';
import importX from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
```

Insert these blocks **before** the final `prettier` entry:
```js
  // --- import hygiene ---
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  {
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({ alwaysTryTypes: true }),
      ],
    },
    rules: {
      'import-x/no-duplicates': 'error',
      'import-x/no-cycle': 'error',
      'import-x/no-self-import': 'error',
      // perfectionist owns ordering; consistent-type-imports (Task 3) owns inline type style.
      'import-x/order': 'off',
    },
  },

  // --- perfectionist: auto-sort imports, NO blank lines between them ---
  {
    plugins: { perfectionist },
    rules: {
      'perfectionist/sort-imports': [
        'error',
        {
          type: 'natural',
          order: 'asc',
          newlinesBetween: 'never',
          groups: [
            'type',
            ['builtin', 'external'],
            'internal-type',
            'internal',
            ['parent-type', 'sibling-type', 'index-type'],
            ['parent', 'sibling', 'index'],
            'side-effect',
            'object',
            'unknown',
          ],
        },
      ],
      'perfectionist/sort-named-imports': ['error', { type: 'natural', order: 'asc' }],
      'perfectionist/sort-named-exports': ['error', { type: 'natural', order: 'asc' }],
      'perfectionist/sort-exports': ['error', { type: 'natural', order: 'asc' }],
    },
  },
```

> `newlinesBetween: 'never'` removes blank lines **between every import line, including between groups** — the user's "no blank lines between imports" requirement. (A single blank line *after* the whole import block is Prettier/idiom and is unaffected.) No conflict with Prettier (it never sorts imports), and `import-x/order: off` cedes ordering to perfectionist. We intentionally do **not** add `import-x/consistent-type-specifier-style` — `consistent-type-imports` with `fixStyle: 'inline-type-imports'` (Task 3) is the single authority on inline type specifiers.

- [ ] **Step 3: Verify auto-fix sorts and de-blanks imports**

Create temp `src/rfm/imptest.ts`:
```ts
import { readFile } from 'node:fs';

import { parse } from 'node:path';
```
Run: `pnpm lint:fix`
Expected: imports reordered into natural order **with no blank line between them**. Delete the temp file afterward.

- [ ] **Step 4: Commit**

```bash
git add eslint.config.mjs package.json pnpm-lock.yaml
git commit -m "🔧 chore: perfectionist import sort (no blank lines) + import-x hygiene"
```

---

## Task 5: React / web layer (scoped to `src/web`)

**Files:**
- Modify: `eslint.config.mjs` (add React entries before `prettier`)
- Modify: `package.json` (devDeps)

- [ ] **Step 1: Add deps** (minimum versions pinned so the range can't resolve to a flat-config-less release)

Run: `pnpm add -D eslint-plugin-react@^7.37 eslint-plugin-react-hooks@^5 eslint-plugin-react-refresh@^0.4 eslint-plugin-jsx-a11y@^6.10`

- [ ] **Step 2: Add the React entries** to `eslint.config.mjs`, **before** the final `prettier` entry.

> **Critical:** these must be **separate array entries**, not one object with spreads + redefined `plugins`/`rules` — in a single object literal the later `plugins`/`rules` keys overwrite the spread ones, silently dropping the `react` plugin and all its rules. Each entry is independently scoped with `files`.

Add imports at the top:
```js
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';
```

Add the entries:
```js
  // --- React recommended + jsx-runtime (separate, scoped entries) ---
  { files: ['src/web/**/*.{ts,tsx}'], ...react.configs.flat.recommended },
  { files: ['src/web/**/*.{ts,tsx}'], ...react.configs.flat['jsx-runtime'] },

  // --- hooks / a11y / refresh for web ---
  {
    files: ['src/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    settings: { react: { version: 'detect' } },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
```

> **Plugin flat-config keys drift between releases.** If `pnpm lint` throws "Cannot read properties of undefined", check the installed plugin's README for the exact export name — e.g. react-hooks v5 may expose `configs['recommended-latest']` instead of `configs.recommended`; jsx-a11y may expose `flatConfigs.recommended` vs `configs.recommended`. This is the one place to expect a small version-specific fix — **verify by running**, don't assume.

- [ ] **Step 3: Verify the web layer loads and React rules apply**

Create `src/web/Probe.tsx`:
```tsx
import type { ReactElement } from 'react';

export function Probe(): ReactElement {
  return <div>probe</div>;
}
```
Run: `pnpm lint`
Expected: parses `.tsx` under Bundler resolution, 0 errors. Then add a hooks violation and a core-react violation to confirm both layers are live:
```tsx
import { useState } from 'react';

export function Bad(): null {
  if (Math.random() > 0.5) {
    useState(0); // react-hooks/rules-of-hooks
  }
  return <div role="foo" />; // jsx-a11y/aria-role (core a11y) — and rules-of-hooks above
}
```
Run `pnpm lint` → Expected: `react-hooks/rules-of-hooks` **and** a jsx-a11y error. Delete both probe files afterward.

- [ ] **Step 4: Commit**

```bash
git add eslint.config.mjs package.json pnpm-lock.yaml
git commit -m "⚛️ chore: scoped React/JSX/a11y lint layer for src/web"
```

---

## Task 6: vitest lint layer + lefthook (fast pre-commit, typecheck on pre-push)

**Files:**
- Modify: `eslint.config.mjs` (add a vitest block for test files, before `prettier`)
- Create: `lefthook.yml`
- Modify: `package.json` (lefthook + @vitest/eslint-plugin devDeps; `prepare` script)

- [ ] **Step 1: Add deps**

Run: `pnpm add -D lefthook @vitest/eslint-plugin`

- [ ] **Step 2: Add the vitest test block** to `eslint.config.mjs` (before the final `prettier` entry)

Add import:
```js
import vitest from '@vitest/eslint-plugin';
```
Add block:
```js
  // --- test files: vitest rules ---
  {
    files: ['**/*.test.{ts,tsx}'],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
    },
  },
```

- [ ] **Step 3: Create `lefthook.yml`**

```yaml
pre-commit:
  piped: true # run commands sequentially (lint then format) — never race two auto-fixers on the same files
  commands:
    1_lint:
      glob: '*.{ts,tsx,mts,cts}'
      run: pnpm exec eslint --fix --no-warn-ignored {staged_files}
      stage_fixed: true
    2_format:
      glob: '*.{ts,tsx,mts,cts,json,jsonc,css,html}'
      run: pnpm exec prettier --write --ignore-unknown {staged_files}
      stage_fixed: true

pre-push:
  commands:
    typecheck:
      run: pnpm typecheck
```

> Pre-commit stays fast (staged files only, lint→format sequential). Whole-project `tsc -b` runs on **pre-push** — it's `--build` incremental (`.tsbuildinfo` cached) so it's cheap on repeat, and putting it at push-time avoids the "every commit pays two cold full type-checks → people use `--no-verify`" failure mode. `import-x/no-cycle` (the most expensive lint rule) runs in the staged-file `pnpm lint`; if lint time grows uncomfortable later, move `no-cycle` to a CI/pre-push-only config.

- [ ] **Step 4: Add `prepare` script** to `package.json` so hooks install on `pnpm install`:

```json
"prepare": "lefthook install"
```
Then run: `pnpm exec lefthook install`

- [ ] **Step 5: Verify the hook fires**

Stage a deliberately mis-sorted/unformatted `.ts` file, then `git commit -m "test"` in a throwaway state.
Expected: lefthook runs, auto-fixes import order + formatting, re-stages, and either commits clean or blocks on a real lint error. Reset afterward (`git reset --soft HEAD~1` if it committed). Then test pre-push gating is wired (a `git push --dry-run` to a throwaway/no remote is not reliable; instead confirm `pnpm typecheck` passes standalone).

- [ ] **Step 6: Commit**

```bash
git add lefthook.yml eslint.config.mjs package.json pnpm-lock.yaml
git commit -m "🪝 chore: lefthook (fast pre-commit + pre-push typecheck) + vitest lint layer"
```

---

## Task 7: Final full-project verification

- [ ] **Step 1: Remove all temp probe files** (`Probe.tsx`, `imptest.ts`, any `bad()` additions). `src/rfm/sample.ts` may remain if Task 0 created it and no real source exists yet.

- [ ] **Step 2: Run the full gate**

Run:
```bash
pnpm install
pnpm lint
pnpm format
pnpm typecheck
```
Expected: all three pass with exit 0.

- [ ] **Step 3: Commit any final cleanup**

```bash
git add -A
git commit -m "✅ chore: lint/format/typecheck toolchain green"
```

---

## Notes / deliberately out of scope

- **`no-unnecessary-condition` at parse boundaries (rfm):** this rule flags defensive checks the type system believes are redundant — exactly what a CriticMarkup parser writes at trust boundaries. The honest fix is a **code-style rule for `rfm`**: type external/parsed input as `unknown` (or validate with a schema) and narrow explicitly, so the checks become *necessary*. `noUncheckedIndexedAccess` already makes index access `T | undefined`. Bake this into the rfm implementation guidance; do **not** sprinkle `eslint-disable`.
- **CI (GitHub Actions):** skipped — the design doc states there is no remote yet. lefthook covers local enforcement. When a remote exists, add a workflow (lint → format → typecheck → test, mirroring difit's `.github/workflows/ci.yml`) and consider moving `import-x/no-cycle` to a CI-only config.
- **knip (unused-export detection):** difit uses it; valuable but additive. Deferred to keep this plan focused.
- **Node/React version revisit:** tracked separately per the user's request. When done, reconcile leaf-config `target`/`lib` (ES2022 → ES2023 is safe on Node 22/24) and `@types/node`.
- **Markdown formatting:** `.prettierignore` excludes `*.md` to protect the hard-wrapped docs. Revisit if you want prose formatted.

## Self-review (author) + incorporated review findings

> **Implementation correction (discovered during execution):** the plan specified
> `tsconfig.node.json` as `composite: true` + `noEmit: true`, but TS project references
> forbid referencing a `noEmit` project (TS6310), while dropping the web→node reference
> breaks `src/web` importing `src/rfm` under `tsc -b` (TS6307). Resolved by making the
> **referenced node project emit declarations** (`declaration` + `emitDeclarationOnly`,
> `outDir` to the gitignored `node_modules/.cache/tsc/node-decls`) instead of `noEmit`,
> and restoring `tsconfig.web.json`'s reference to node. `tsconfig.build.json` overrides
> back to JS emit. Web stays `noEmit` (it's referenced only by the solution root, which
> permits it). All locked decisions are unaffected — this is a tsconfig-mechanism fix only.
> Also: lefthook globs were widened to include `.mjs/.cjs/.js` so config files are caught.

This plan was reviewed by a structural reviewer (Completeness / Spec Alignment / Decomposition / Buildability) and a Risk & Feasibility reviewer. Changes made in response:

- **[Critical] type-aware project resolution** — replaced the broken `projectService` + single `tsconfig.eslint.json` design with a solution-root + project-references layout (`tsconfig.json` → node/web leaves), so `projectService` routes every file (incl. tests) to its correct project, and **web is type-checked under Bundler** (no `no-unsafe-*` false-positive storm).
- **[Critical] React layer** — split the spread-then-override object into **separate scoped array entries** so the `react` plugin and its recommended/jsx-runtime rules are actually applied (the old form silently dropped them).
- **[Important] `no-console`** — kept global `error` but scoped **off for `src/cli`** and **`allow:['warn','error']` for `src/server`** (a CLI's job is stdout; the server logs errors).
- **[Important] Task 0 / tsconfig bootstrap** — Task 1 now creates **complete** tsconfig files (not a merge into v1's), so the bootstrap path is self-contained; Global Constraints state this supersedes v1 Steps 2–3.
- **[Important] lefthook** — `piped: true` sequential (no parallel auto-fixer race); whole-project `tsc -b` moved to **pre-push**, incremental via `.tsbuildinfo`.
- **[Important] `strict-boolean-expressions`** — set every `allow*: false` to match the "true maximum" decision (was implicitly at permissive defaults).
- **[Suggestion]** version pins (`eslint-import-resolver-typescript@^3.7`, `eslint-plugin-react@^7.37`, `jsx-a11y@^6.10`); dropped redundant `import-x/consistent-type-specifier-style`; dropped `noUnusedLocals`/`noUnusedParameters` in favor of the auto-fixable ESLint rule; top-level resolver import; probe uses `import type { ReactElement }`; added rfm `unknown`-typing guidance.

Spec coverage: ESLint+Prettier ✅ (T2,T3), perfectionist no-blank-line imports ✅ (T4), full type-aware incl. the 3 friction rules at true-max ✅ (T3), enum/legacy ban at compiler ✅ (T1) and lint ✅ (T3), tsconfig hardening ✅ (T1), Node/React untouched ✅. No placeholders; script names and the single additive `eslint.config.mjs` (base → import → perfectionist → React → vitest → overrides → **prettier last**) are consistent across tasks.
