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
