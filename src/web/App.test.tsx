import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownView } from './MarkdownView.js';
import '@testing-library/jest-dom/vitest';

describe('MarkdownView', () => {
  it('renders GFM headings and lists', () => {
    render(<MarkdownView source={'# Title\n\n- a\n- b\n'} />);
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
