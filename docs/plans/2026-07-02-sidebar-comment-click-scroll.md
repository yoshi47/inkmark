# サイドバーのコメントクリックで本文該当箇所へスクロール

## Context

inkmark の Web ビューでは、右側の `CommentSidebar` にコメントスレッドとサジェストが並ぶが、クリックしても本文のどこに付いたコメントか分からない。クリックで本文ビュー（`<article class="markdown-body">`）内の該当 `<mark>` までスクロールできるようにする。

対応付けは既に存在する: サイドバーの各スレッドはコメント `id`（例 `c1`）をキーに持ち（`src/web/CommentSidebar.tsx:36`）、本文側は `rehypeCriticMarkup` が `<mark data-cm-kind data-cm-id>` を出力している（`src/web/rehypeCriticMarkup.ts:42-49`）。スクロールコンテナ `<article>` への ref も `App.tsx:14` に既存（`articleRef`）。新規インフラは不要で、クリックハンドラと id 検索スクロールを配線するだけ。

## 設計判断

1. **ハンドラ配置**: `CommentSidebar` に `onSelect(id)` コールバック prop を追加し、`App` がスクロールを実行する。`App` が `articleRef` を所有しており、サイドバーの既存パターン（`onReply`/`onResolve`/`onSuggestion`）とも一致。サイドバーに ref を渡す案・context 案は不採用（DOM 知識の漏出／過剰装備）。
2. **mark の検索**: `querySelectorAll('mark[data-cm-id]')` を走査して `dataset['cmId'] === id` で比較する。セレクタへの文字列埋め込み（escape 問題）を構造的に回避でき、既存テストの `dataset['srcStart']` 比較（`App.integration.test.tsx:44`）とも一致するパターン（`noPropertyAccessFromIndexSignature` 有効のため `dataset['cmId']` 表記）。なお id は `/^[cs]\d+$/`（`src/rfm/parse.ts:26`）なので escape は実際には不要だが、走査比較のほうが前提に依存しない。
3. **スクロール先の意味論**: `{==選択テキスト==}{>>ノート<<}{#c1}` の場合、`data-cm-id="c1"` はハイライト mark ではなく直後のコメントノート mark に付く（`rehypeCriticMarkup.test.ts:37-43` で確認: highlight mark は id 無し、comment mark が id 持ち）。両 mark はソース上・描画上とも隣接しているため、コメント mark へのスクロール（`block: 'center'`）で選択テキストも同時に視界に入る。ハイライト mark 側へ id を付ける改修は不要（スコープ外）。
4. **サジェストもスクロール対象**: insertion/deletion は `RENDERED_KINDS`（`rehypeCriticMarkup.ts:5`）に含まれ `data-cm-id` 付き mark になる。substitution は mark 化されないため、検索がヒットせず無害な no-op になる（意図した挙動として許容）。
5. **a11y**: `eslint.config.mjs` で `jsx-a11y` recommended が有効なため、div への onClick は `click-events-have-key-events` 等で落ちる。クリック対象（コメントヘッダ・サジェストラベル）を `<button>` に変更する（キーボード操作も無償で得られる）。`.thread` 全体はクリック対象にしない（内部に Reply 入力・Resolve ボタン等のインタラクティブ要素があるため）。
6. **スクロール先の一時ハイライトはスコープ外**（フォローアップ候補: `cm-flash` アニメーションクラス）。mark 自体に背景色があり、`block: 'center'` で十分視認できる。

## 変更ファイル

### 1. `src/web/CommentSidebar.tsx`

- `SidebarProps`（4-9行）に `onSelect: (id: string) => void;` を追加し、destructure に加える
- コメントヘッダ（40-42行）を button 化:

```tsx
<button
  className="comment"
  onClick={() => {
    onSelect(id);
  }}
>
  <b>{c.by}</b>: {inlineBody(id)}
</button>
```

- サジェストラベル（81行 `<div>{label}</div>`）も同様に `<button className="suggestion-label" onClick={...}>{label}</button>` へ

（既存のこのファイルのボタンは `type=` 省略スタイル。それに合わせる）

### 2. `src/web/App.tsx`

`App` 内にヘルパーを追加（`explicit-function-return-type` のため `: void` 明示）:

```tsx
function scrollToSpan(id: string): void {
  const root = articleRef.current;
  if (root === null) return;
  for (const el of root.querySelectorAll<HTMLElement>('mark[data-cm-id]')) {
    if (el.dataset['cmId'] === id) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
  }
}
```

`<CommentSidebar>`（76-83行）に `onSelect={scrollToSpan}` を追加。

補足: `NodeListOf` の for-of は tsconfig.web の `DOM.Iterable` で可。span が複数 mark に分割される場合は先頭へスクロール（望ましい挙動）。

### 3. `src/web/theme.css`

button 化した要素の見た目を従来の div と同一にする:

グローバル衝突を避けるため `.comment-sidebar` にスコープする:

```css
.comment-sidebar .comment,
.comment-sidebar .suggestion-label {
  display: block;
  width: 100%;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
```

### 4. `src/web/App.integration.test.tsx`（テスト追加）

スクロールロジックは App 側にあるため App レベルの統合テストで検証する。jsdom は `Element.prototype.scrollIntoView` を実装しないため stub を代入する（`vi.fn().mock.instances` は `strictTypeChecked` の `no-unsafe-*` に抵触するので、`this` を記録する関数 stub を使う）。stub の代入はテスト間リークを避けるため、既存の `Range.prototype.getBoundingClientRect` stub（`App.integration.test.tsx:31`）と同様 `beforeEach` に置く:

```tsx
// beforeEach 内（既存の Range stub の隣）:
scrolled.length = 0;
Element.prototype.scrollIntoView = function (this: Element): void {
  scrolled.push(this);
};
```

```tsx
const scrolled: Element[] = []; // モジュールスコープ（h と同レベル）

test('clicking a sidebar comment scrolls to its mark', async () => {
  h.state.content = [
    'Intro paragraph.',
    '',
    'Some {==target text==}{>>note<<}{#c1} here.',
    '',
    '---',
    'comments:',
    '  c1:',
    '    by: user',
    '    at: 2026-06-30T00:00:00.000Z',
    '    resolved: false',
    '',
  ].join('\n');

  const { container } = render(<App />);
  const commentButton = await waitFor(() => {
    const b = container.querySelector<HTMLButtonElement>('.comment-sidebar button.comment');
    if (b === null) throw new Error('sidebar not rendered yet');
    return b;
  });

  fireEvent.click(commentButton);

  expect(scrolled).toHaveLength(1);
  expect(scrolled[0]?.tagName).toBe('MARK');
  expect(scrolled[0]).toHaveAttribute('data-cm-id', 'c1');
});
```

補足:
- スクロール先はハイライトではなく隣接するコメントノート mark（設計判断3）。アサーションの `data-cm-id="c1"` mark はノートテキスト（`note`）を含む要素になる
- サジェスト経路もカバーする追加テストを推奨（レビュー指摘）: content に `{++ins++}{#s1}` を含め、`.comment-sidebar button.suggestion-label` をクリックして `data-cm-id="s1"` の mark にスクロールすることを確認（同じ `scrollToSpan` に合流するため安価な1本）
- この新テストは `h.state.content` を書き換えるため、`beforeEach`（26-32行付近）で content を明示的にリセットする（例: `h.state.content = 'This is **bold** and plain text.\n';`）。endmatter 形式（`---` + YAML）は `demo.md:22-27` で確認済み

## 検証

```
pnpm run lint        # jsx-a11y / strictTypeChecked / explicit-function-return-type
pnpm run typecheck   # tsc -b
pnpm run test        # vitest run（web プロジェクト: jsdom）
pnpm run format      # prettier --check .
```

手動確認: `pnpm run build && bin/inkmark open demo.md` で起動し（CLI は `open|status|stop` サブコマンド形式、`src/cli/index.ts:92-108`。`bin/inkmark` は `dist/` を読むため要ビルド）、本文を該当箇所から離れた位置までスクロールした状態で
1. 各コメントスレッドのヘッダをクリック → `.markdown-body` がスムーズスクロールして mark が中央付近に来る
2. サジェスト（insertion `s1` / deletion `s2`）のラベルクリックでも同様
3. Tab でコメントヘッダにフォーカスでき、Enter でスクロールする
4. Reply / Resolve / Accept / Reject が従来どおり動く（新 button は既存ボタンを包まないためバブリング退行なし）

## リスク / 備考

- resolved 済みスレッドのクリックもスクロールする（mark はソースに残るため）— 意図どおり
- substitution サジェストは mark が無く no-op。必要になったら `RENDERED_KINDS` 拡張（スコープ外）
- `scrollIntoView` はネストされたスクロールコンテナ（`.markdown-body` の overflow: auto）をネイティブに処理するため手動計算不要
