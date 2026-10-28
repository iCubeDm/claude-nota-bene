import type { ReactNode } from 'react';

/** The bar's icons: 24×24 outlines in the lucide style (the project has no icon library). */
const svg = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const PlayIcon = () => svg(<polygon points="6 4 20 12 6 20 6 4" fill="currentColor" />);
export const PauseIcon = () => svg(<><rect x="6" y="4" width="4" height="16" fill="currentColor" /><rect x="14" y="4" width="4" height="16" fill="currentColor" /></>);
export const ReplayIcon = () => svg(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></>);
const speaker = <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />;
export const VolumeOffIcon = () => svg(<>{speaker}<line x1="22" y1="9" x2="16" y2="15" /><line x1="16" y1="9" x2="22" y2="15" /></>);
export const VolumeLowIcon = () => svg(<>{speaker}<path d="M15.5 8.5a5 5 0 0 1 0 7" /></>);
export const VolumeHighIcon = () => svg(<>{speaker}<path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M19 5a10 10 0 0 1 0 14" /></>);
export const PencilIcon = () => svg(<><path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" /></>);
export const PipIcon = () => svg(<><path d="M21 9V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" /><rect x="12" y="13" width="10" height="7" rx="1" /></>);
export const EnterFullscreenIcon = () => svg(<><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></>);
export const ExitFullscreenIcon = () => svg(<><path d="M8 3v3a2 2 0 0 1-2 2H3" /><path d="M21 8h-3a2 2 0 0 1-2-2V3" /><path d="M3 16h3a2 2 0 0 1 2 2v3" /><path d="M16 21v-3a2 2 0 0 1 2-2h3" /></>);
