export function LogoMark({ size = 34 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      role="img"
      aria-label="Reformat"
      className="logo-mark"
    >
      <defs>
        <linearGradient id="logo-bg" x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#222922" />
          <stop offset="1" stopColor="#0B0E0B" />
        </linearGradient>
        <linearGradient id="logo-paper" x1="350" y1="280" x2="760" y2="800" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FCFAF3" />
          <stop offset="1" stopColor="#E7E1D2" />
        </linearGradient>
      </defs>
      <rect x="20" y="20" width="984" height="984" rx="238" fill="url(#logo-bg)" />
      <rect x="294" y="218" width="360" height="470" rx="58" fill="#F6F2E8" opacity="0.3" transform="rotate(-10 474 453)" />
      <rect x="352" y="272" width="360" height="470" rx="58" fill="url(#logo-paper)" />
      <g stroke="#171B18" strokeWidth="36" strokeLinecap="round">
        <path d="M446 402H618" />
        <path d="M446 494H565" />
        <path d="M446 586H512" />
      </g>
      <circle cx="704" cy="724" r="138" fill="#D7F56A" />
      <g stroke="#171B18" strokeWidth="34" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M647 724H757" />
        <path d="M714 681L757 724L714 767" />
      </g>
    </svg>
  );
}
