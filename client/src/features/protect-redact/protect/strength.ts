/** Password strength estimate for the meter in the password dialog (0 = empty … 4 = very strong). */
export interface Strength {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  hint: string;
}

const COMMON = [
  'password', 'passw0rd', '123456', '12345678', 'qwerty', 'letmein', 'welcome', 'admin', 'abc123', 'iloveyou',
  'monkey', 'dragon', 'secret', 'pdfwizard', 'military', 'test', 'login', '111111', '000000', 'football',
];

export function passwordStrength(pw: string): Strength {
  if (!pw) return { score: 0, label: '', hint: 'Use at least 8 characters with a mix of letters, numbers and symbols.' };
  const lower = pw.toLowerCase();
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  let points = 0;
  if (pw.length >= 6) points++;
  if (pw.length >= 8) points++;
  if (pw.length >= 12) points++;
  if (pw.length >= 16) points++;
  points += Math.max(0, classes - 1);
  const repeated = /^(.)\1*$/.test(pw) || /(.)\1{3,}/.test(pw);
  const sequence = /(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwer|asdf|zxcv)/i.test(pw);
  const common = COMMON.some((w) => lower.includes(w));
  if (repeated) points -= 2;
  if (sequence) points -= 1;
  if (common) points -= 2;
  const score = (pw.length < 6 ? 1 : Math.max(1, Math.min(4, Math.round(points / 1.6)))) as Strength['score'];
  const labels = ['', 'Weak', 'Medium', 'Strong', 'Very strong'];
  let hint = '';
  if (pw.length < 8) hint = 'Use at least 8 characters.';
  else if (common) hint = 'Avoid common words and names.';
  else if (classes < 3) hint = 'Mix upper and lower case letters, numbers and symbols.';
  else if (score < 4) hint = 'Longer passwords are harder to guess.';
  return { score, label: labels[score], hint };
}
