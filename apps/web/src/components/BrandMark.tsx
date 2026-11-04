// The Tandem logo. Keep this drawing in sync with public/tandem.svg, the favicon.
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="10" fill="#0b3954" />
      <path
        d="M9 13h22M14 13v16M26 13v16M14 23h12"
        fill="none"
        stroke="white"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
