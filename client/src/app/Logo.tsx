/** PDF Wizard logo: a grey-hatted, white-bearded wizard with a glowing staff, on a navy tile. */
export function WizardLogo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="14" fill="#1f3a5f"/>
      <circle cx="52" cy="13" r="5" fill="#ffe9a8" opacity="0.35"/>
      <path d="M52 16 L50 58" stroke="#8a5a2b" strokeWidth="3" strokeLinecap="round"/>
      <circle cx="52" cy="13" r="3" fill="#fff4c8"/>
      <path d="M38 3 C35 7 34 10 31 14 L20 29 H44 L38 15 C37 11 39 7 42 6 Z" fill="#8f98a3"/>
      <path d="M31 14 L20 29 H44 L38 15" fill="none" stroke="#6f7883" strokeWidth="1.2" strokeLinejoin="round"/>
      <ellipse cx="32" cy="29.5" rx="20" ry="4" fill="#a9b1ba"/>
      <ellipse cx="32" cy="35" rx="8" ry="6" fill="#f0c8a4"/>
      <path d="M24.5 33 Q28 30.5 31 32.5 M33 32.5 Q36 30.5 39.5 33" stroke="#f7f7f7" strokeWidth="2.2" strokeLinecap="round" fill="none"/>
      <circle cx="28.8" cy="35" r="1" fill="#2b2b2b"/>
      <circle cx="35.2" cy="35" r="1" fill="#2b2b2b"/>
      <path d="M21 35 Q22 50 32 61 Q42 50 43 35 Q39 41 35 40 Q32 42 29 40 Q25 41 21 35 Z" fill="#f4f4f4"/>
      <path d="M28 40 Q32 43.5 36 40" stroke="#dcdcdc" strokeWidth="1.2" fill="none" strokeLinecap="round"/>
      <path d="M32 44 V56 M28 45 Q29 51 31 55 M36 45 Q35 51 33 55" stroke="#dedede" strokeWidth="0.9" fill="none" strokeLinecap="round"/>
    </svg>
  );
}
