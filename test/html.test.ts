import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../src/html.js';

describe('htmlToMarkdown', () => {
  it('turns Tripwire comment HTML into Discord markdown', () => {
    const html = '<a style="color: rgb(42, 159, 214); font-family: &amp;quot;Droid Sans&amp;quot;" href="https://zkillboard.com/corporation/98575203/">Dark Venture Corporation</a><span style="display: inline !important;"> lives here.</span><br />&nbsp;<div>Baiting with <b>mining barges</b></div><ul><li>15+ HACs</li><li>fort</li></ul>';
    expect(htmlToMarkdown(html)).toBe('[Dark Venture Corporation](https://zkillboard.com/corporation/98575203/) lives here.\n\nBaiting with **mining barges**\n\n• 15+ HACs\n• fort');
  });
  it('leaves plain text alone apart from entities', () => {
    expect(htmlToMarkdown('Very active ratting &amp; mining')).toBe('Very active ratting & mining');
  });
});
