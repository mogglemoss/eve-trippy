/**
 * Embed plumbing: turn lines into one or more embeds that respect Discord's
 * limits (4096 chars per description, 10 embeds and 6000 chars per message),
 * and send them across as few messages as possible.
 */
import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { chunkLines } from '../chain/render.js';
import { AUTHOR } from './voice.js';

export interface EmbedSpec {
  title?: string;
  url?: string | null;
  colour: number;
  lines: string[];
  /** Appended to the sign-off in the footer: usually the Tripwire host and data age. */
  footer?: string;
  authorIcon?: string | null;
}

const DESCRIPTION_LIMIT = 4000;
const MESSAGE_LIMIT = 5800;

export function embedsFromLines(spec: EmbedSpec): EmbedBuilder[] {
  const chunks = chunkLines(spec.lines.length ? spec.lines : ['—'], DESCRIPTION_LIMIT);
  return chunks.map((chunk, i) => {
    const e = new EmbedBuilder().setColor(spec.colour).setDescription(chunk.join('\n'));
    if (i === 0) {
      if (spec.title) e.setTitle(spec.title);
      if (spec.url) e.setURL(spec.url);
      e.setAuthor({ name: AUTHOR, ...(spec.authorIcon ? { iconURL: spec.authorIcon } : {}) });
    }
    if (i === chunks.length - 1) {
      if (spec.footer) e.setFooter({ text: spec.footer });
    }
    return e;
  });
}

/** editReply with as many embeds as fit, then followUp with the rest. */
export async function sendEmbeds(i: ChatInputCommandInteraction, embeds: EmbedBuilder[]): Promise<void> {
  const batches: EmbedBuilder[][] = [];
  let batch: EmbedBuilder[] = [];
  let size = 0;
  for (const e of embeds) {
    const len = e.length;
    if (batch.length && (batch.length >= 10 || size + len > MESSAGE_LIMIT)) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(e);
    size += len;
  }
  if (batch.length) batches.push(batch);
  const first = batches.shift() ?? [];
  await i.editReply({ embeds: first });
  for (const b of batches) await i.followUp({ embeds: b });
}
