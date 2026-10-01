/** Tool ids and tool-option defaults shared by the overlay, the options bars and the panel. */
import type { DateFormat } from './date';
import { DEFAULT_FONT_SIZE, DEFAULT_MARK_COLOR, DEFAULT_TEXT_COLOR, type MarkKind, type SigRole } from './model';

export const TOOL_TEXT = 'fill-text';
export const TOOL_DATE = 'fill-date';
export const TOOL_SIGNATURE = 'fill-signature';
export const TOOL_INITIALS = 'fill-initials';

export const MARK_TOOLS: Record<string, MarkKind> = {
  'fill-cross': 'cross',
  'fill-check': 'check',
  'fill-dot': 'dot',
  'fill-line': 'line',
  'fill-circle': 'circle',
};

export const SIG_TOOLS: Record<string, SigRole> = {
  [TOOL_SIGNATURE]: 'signature',
  [TOOL_INITIALS]: 'initials',
};

export const FILL_TOOL_IDS = [TOOL_TEXT, 'fill-cross', 'fill-check', 'fill-dot', 'fill-line', 'fill-circle', TOOL_DATE, TOOL_SIGNATURE, TOOL_INITIALS];
export const isFillTool = (id: string) => FILL_TOOL_IDS.includes(id);

/** Options of the text tool (also used by the date tool). */
export const TEXT_OPTIONS_KEY = TOOL_TEXT;
export const TEXT_DEFAULTS: { fontSize: number; color: string } = { fontSize: DEFAULT_FONT_SIZE, color: DEFAULT_TEXT_COLOR };

/** One colour shared by every symbol tool. */
export const MARK_OPTIONS_KEY = 'fill-sign-marks';
export const MARK_DEFAULTS: { color: string } = { color: DEFAULT_MARK_COLOR };

export const DATE_OPTIONS_KEY = TOOL_DATE;
export const DATE_DEFAULTS: { format: DateFormat } = { format: 'locale' };
