/** Date formats for the "Date" fill tool. */
export type DateFormat = 'locale' | 'mdy' | 'dmy' | 'ymd' | 'long';

export const DATE_FORMATS: { id: DateFormat; label: string }[] = [
  { id: 'locale', label: 'Default for my region' },
  { id: 'mdy', label: 'MM/DD/YYYY' },
  { id: 'dmy', label: 'DD/MM/YYYY' },
  { id: 'ymd', label: 'YYYY-MM-DD' },
  { id: 'long', label: 'Month D, YYYY' },
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad = (n: number) => String(n).padStart(2, '0');

export function formatDate(date: Date, format: DateFormat): string {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  switch (format) {
    case 'mdy':
      return `${pad(m)}/${pad(d)}/${y}`;
    case 'dmy':
      return `${pad(d)}/${pad(m)}/${y}`;
    case 'ymd':
      return `${y}-${pad(m)}-${pad(d)}`;
    case 'long':
      return `${MONTHS[m - 1]} ${d}, ${y}`;
    default:
      try {
        return date.toLocaleDateString();
      } catch {
        return `${pad(m)}/${pad(d)}/${y}`;
      }
  }
}

export const isDateFormat = (v: unknown): v is DateFormat => DATE_FORMATS.some((f) => f.id === v);
