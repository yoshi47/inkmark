export type MarkKind = 'comment' | 'highlight' | 'insertion' | 'deletion' | 'substitution';

export interface Span {
  kind: MarkKind;
  start: number; // offset in body, inclusive
  end: number; // offset in body, exclusive
  inner: string; // raw inner text
  oldText?: string; // substitution: text before ~>
  newText?: string; // substitution: text after ~>
  id?: string; // from a trailing {#cN}/{#sN}
}

export interface CommentMeta {
  by: string;
  at: string;
  re?: string;
  body?: string;
  resolved?: boolean;
}

export interface SuggestionMeta {
  by: string;
  at: string;
  resolved?: boolean;
}

export interface Endmatter {
  comments: Record<string, CommentMeta>;
  suggestions: Record<string, SuggestionMeta>;
}

export interface ParsedDoc {
  body: string;
  endmatterRaw: string | null;
  spans: Span[];
  endmatter: Endmatter;
}
