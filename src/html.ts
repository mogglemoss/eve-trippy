/**
 * Tripwire's comment editor stores HTML, inline styles included. This turns
 * it into the little markdown Discord renders: links, bold, italics, line
 * breaks and bullets survive; everything else is stripped and entities
 * decoded. No dependency; the input is small and the tags are few.
 */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©' };

export function decodeEntities(s: string): string {
  // Tripwire double-encodes sometimes (&amp;quot;), so decode until stable.
  let prev = '';
  let out = s;
  for (let i = 0; i < 3 && out !== prev; i++) {
    prev = out;
    out = out
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
  }
  return out;
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
};

export function htmlToMarkdown(html: string): string {
  if (!/<[a-z!/]/i.test(html)) return decodeEntities(html).trim();
  let s = html.replace(/\r/g, '').replace(/\n+/g, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  // Block-level tags become line breaks; list items become bullets.
  s = s.replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/?\s*(p|div|h[1-6]|tr|blockquote|pre)\b[^>]*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n• ').replace(/<\s*\/\s*li\s*>/gi, '').replace(/<\s*\/?\s*(ul|ol)\b[^>]*>/gi, '')
    .replace(/<\s*(td|th)\b[^>]*>/gi, ' ');
  // Inline formatting. Links keep their href; the visible text is escaped.
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, tag: string, inner: string) => {
    const href = attr(tag, 'href');
    const text = decodeEntities(inner.replace(/<[^>]+>/g, '')).trim();
    if (!href || !/^https?:\/\//i.test(href)) return text;
    return `[${text}](${href})`;
  });
  const wrap = (open: string, close: string) => (_: string, inner: string) => {
    const t = inner.trim();
    return t ? `${open}${t}${close}` : '';
  };
  s = s.replace(/<\s*(b|strong)\b[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi, (_, __, inner) => wrap('**', '**')(_, inner));
  s = s.replace(/<\s*(i|em)\b[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi, (_, __, inner) => wrap('*', '*')(_, inner));
  s = s.replace(/<\s*(u)\b[^>]*>([\s\S]*?)<\/\s*u\s*>/gi, (_, __, inner) => wrap('__', '__')(_, inner));
  s = s.replace(/<\s*(s|strike|del)\b[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi, (_, __, inner) => wrap('~~', '~~')(_, inner));
  s = s.replace(/<\s*code\b[^>]*>([\s\S]*?)<\/\s*code\s*>/gi, (_, inner) => `\`${inner.replace(/<[^>]+>/g, '')}\``);
  // Everything else goes.
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  // Tidy whitespace: collapse runs of spaces, at most one blank line.
  return s.split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
