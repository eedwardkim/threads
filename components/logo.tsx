export function Logo({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className={className}>
      <path d="M6 5.5h13a7.5 7.5 0 0 1 7.5 7.5v13.5h-13A7.5 7.5 0 0 1 6 19V5.5Z" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12.5 11.5v15m0-10h8m-8 5h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
