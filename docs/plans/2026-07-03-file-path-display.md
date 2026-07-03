# inkmark: 開いているファイルのパスを Web UI に表示する

## Context

inkmark は CLI で指定した Markdown ファイルをブラウザで表示・コメントするツールだが、現状ブラウザ側にはファイルパスが一切表示されない（タブタイトルも `index.html` の固定 `<title>inkmark</title>` のみ）。パスが見えるのは起動時のターミナル出力（`src/cli/index.ts:38`）だけで、複数ファイルを開いたときにどのタブがどのファイルか区別できない。

サーバーの `FileStore` は `absPath` を public readonly フィールドとして既に保持している（`src/server/fileStore.ts:7`）ため、API に 1 フィールド足してフロントで表示するだけでよい。新しいユーティリティは不要。

**成果物**: `GET /api/file` が `path` を返し、Web UI の上部ヘッダーに絶対パスが表示され、ブラウザタブのタイトルが `<ファイル名> — inkmark` になる。

## 変更内容

### 1. サーバー: GET /api/file レスポンスに `path` を追加

`src/server/app.ts:20-28` の GET ハンドラーを 1 行変更:

```ts
return c.json({ content, version, path: store.absPath });
```

- `store.absPath` は既存フィールドをそのまま使う。`FileStore` / `start.ts` / CLI は変更不要。
- PUT レスポンスは変更しない（パスはセッション中に変わらないため、初回 GET だけで十分。SSE 更新時も `doRefresh` が GET を再実行するので常に同期する）。
- セキュリティ注記: 絶対パスの開示になるが、サーバーは loopback バインド + Host ヘッダーガード（`app.ts:14-18`）で同一マシンの利用者にしか届かないため許容。ターミナル出力にも既に同じパスが出ている。

### 2. Web API クライアント: 型に `path` を追加

`src/web/api.ts:1-5` の `getFile`:

```ts
export async function getFile(): Promise<{ content: string; path: string; version: string }> {
  const res = await fetch('/api/file');
  if (!res.ok) throw new Error(`getFile ${String(res.status)}`);
  return (await res.json()) as { content: string; path: string; version: string };
}
```

### 3. App.tsx: path state + ヘッダー表示 + document.title

`src/web/App.tsx`:

- state 追加: `const [path, setPath] = useState<string | null>(null);`
- `doRefresh`（63-71行）で `setPath(r.path);` を追加
- `document.title` 更新の effect を追加（basename は `slice(lastIndexOf('/') + 1)` — `split('/').pop()` は `noUncheckedIndexedAccess` 下で `string | undefined` になるため避ける）:

```ts
useEffect(() => {
  if (path === null) return;
  const base = path.slice(path.lastIndexOf('/') + 1);
  document.title = `${base} — inkmark`;
}, [path]);
```

- JSX（74-97行）: `.layout` の先頭にヘッダーを追加。両カラムにまたがるよう CSS で `grid-column: 1 / -1` を指定:

```tsx
return (
  <div className="layout">
    <header className="app-header" title={path ?? ''}>
      {path ?? ''}
    </header>
    <MarkdownView ... />
    ...
  </div>
);
```

（`title` 属性は ellipsis で切れた長いパスをホバーで確認できるようにするため — レビュー Suggestion 反映）

注意（このリポジトリの strict lint 制約）:
- `strict-boolean-expressions`: `path === null` / `path ?? ''` のように明示的に書く（`{path && ...}` は不可）
- `explicit-function-return-type`: effect 内の関数にも注意（インラインコールバックは免除）
- 早期 return（73行 `Loading…`）はヘッダーなしのままでよい

### 4. theme.css: `.layout` を 2 行グリッドに変更 + `.app-header` 追加

`src/web/theme.css:33-38`:

```css
.layout {
  display: grid;
  grid-template-columns: 1fr 320px;
  grid-template-rows: auto minmax(0, 1fr); /* ヘッダー行 + コンテンツ行 */
  gap: 0;
  height: 100vh;
}
.app-header {
  grid-column: 1 / -1;
  padding: 0.4rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--sidebar-bg);
  color: var(--muted);
  font-size: 0.8rem;
  font-family: ui-monospace, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

- `minmax(0, 1fr)` はグリッド子要素（`.markdown-body` / `.comment-sidebar` の `overflow: auto`）が行の高さを突き破らないようにするため。既存のテーマ変数（`--border` / `--sidebar-bg` / `--muted`）を使い、ライト/ダーク両対応はそのまま維持。

### 5. テスト更新

- `src/server/app.test.ts`（25-31行の GET テスト）: レスポンスの cast に `path` を追加し、`expect(body.path).toBe(file)` を追加。`file` は `mkdtemp` 済みの絶対パスなのでそのまま比較できる。
- `src/web/App.integration.test.tsx`（13-21行の `vi.mock('./api.js')`）:
  - `h.state`（5-11行）に `path: '/tmp/fake/doc.md'` などを追加
  - `getFile` モックの戻り値型と resolve オブジェクトに `path` を追加（型を合わせないと `tsc -b` が落ちる）
  - 新規アサーション 1 件: レンダー後にヘッダーへパスが表示されること。**注意 2 点**（レビュー指摘）:
    - `screen` は未 import（1行目は `fireEvent, render, waitFor` のみ）→ import に `screen` を追加（perfectionist の自然順で `fireEvent, render, screen, waitFor`）
    - `getFile` は effect 内で非同期 resolve するため、同期 `getByText` は失敗する → `await screen.findByText('/tmp/fake/doc.md')` を使う（これを await した後なら `expect(document.title).toBe('doc.md — inkmark')` も安全）
- `src/web/App.test.tsx` は `App` をレンダーしない（`MarkdownView` のみ）ため変更不要。

## 変更ファイル一覧

| ファイル | 変更 |
|---|---|
| `src/server/app.ts` | GET レスポンスに `path: store.absPath` を追加（1行） |
| `src/web/api.ts` | `getFile` の型 2 箇所に `path: string` |
| `src/web/App.tsx` | path state、title effect、`<header>` 追加 |
| `src/web/theme.css` | `.layout` grid-template-rows、`.app-header` 追加 |
| `src/server/app.test.ts` | GET テストに path アサーション |
| `src/web/App.integration.test.tsx` | モック同期 + ヘッダー/タイトルのアサーション |
| `docs/design/2026-06-29-inkmark-design.md` | API レスポンス記載の 1 行更新（93行目付近） |

## 検証

1. `pnpm test` — 既存 + 追加テストが全て通ること
2. `pnpm lint && pnpm typecheck` — strict ゲート（`tsc -b`、strictTypeChecked eslint）を通ること
3. E2E 確認: `pnpm build` 後 `node bin/…`（または dev サーバー）で `demo.md` を開き、ブラウザで
   - ヘッダーに絶対パスが表示される
   - タブタイトルが `demo.md — inkmark` になる
   - 既存機能（選択コメント、サイドバー、スクロール）が壊れていない（レイアウト変更があるため `scrollIntoView` の動作を目視確認）
4. ライト/ダークモード両方でヘッダーの配色を確認

## 実装の進め方

各ステップとも TDD（superpowers:test-driven-development）で進める: 先に失敗するテスト（§5 のアサーション）を書き、§1-4 の実装で通す。

## 注記（Suggestion レベル — レビューで挙がったがスコープ外/任意）

- `docs/design/2026-06-29-inkmark-design.md:93` に `GET /api/file → { content, version }` の記載がある。実装時に 1 行更新する（軽微なのでプランに含める）。
- basename 抽出は `/` 区切り前提（macOS/Linux 向けツールのため許容）。Windows 対応が必要になったら `Math.max(lastIndexOf('/'), lastIndexOf('\\'))` に変更。
- 将来的に basename クリックでフルパスコピー等の UX 改善余地があるが、今回はスコープ外。
- `index.html` の静的 `<title>inkmark</title>` はロード完了までのフォールバックとしてそのまま残す。
