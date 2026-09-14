/**
 * One User-Agent for every outbound call. ESI, zKillboard and EVE-Scout all
 * ask for a way to reach the operator; put yours in CONTACT (an email or a
 * URL) and it rides along. Nothing personal is baked in.
 */
const contact = process.env.CONTACT?.trim();
export const USER_AGENT = `Trippy/0.1 (Tripwire Discord bot; https://github.com/mogglemoss/eve-trippy${contact ? `; ${contact}` : ''})`;
