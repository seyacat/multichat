// Iconos SVG propios. Los de plataforma son glifos simples con el color de cada una, no logos oficiales.
import type { JSX } from 'preact';
import type { Platform } from '../lib/types';

export const PLATFORM_COLOR: Record<Platform, string> = {
  telegram: '#2AA3DF',
  discord: '#5865F2',
  whatsapp: '#22B95B',
};

export const PLATFORM_NAME: Record<Platform, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
};

export function PlatformIcon({ type, size = 16 }: { type: Platform; size?: number }) {
  const c = PLATFORM_COLOR[type];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={PLATFORM_NAME[type]} class="platform-icon">
      {type === 'telegram' && (
        <>
          <circle cx="12" cy="12" r="12" fill={c} />
          <path d="M5.5 11.6 17.3 7c.6-.2 1 .2.8.9l-2 9.4c-.1.6-.6.8-1.1.5l-3-2.2-1.5 1.4c-.2.2-.4.3-.7.3l.2-3.1 5.6-5.1c.2-.2 0-.4-.3-.2l-6.9 4.4-3-.9c-.6-.2-.6-.6.1-.8Z" fill="#fff" />
        </>
      )}
      {type === 'discord' && (
        <>
          <rect width="24" height="24" rx="7" fill={c} />
          <path d="M7.2 8.1c1.4-.7 2.9-1 4.8-1s3.4.3 4.8 1c.9 1.5 1.5 3.6 1.5 6.2-1 .9-2.2 1.5-3.4 1.8l-.8-1.2c-1.4.4-2.8.4-4.2 0l-.8 1.2c-1.2-.3-2.4-.9-3.4-1.8 0-2.6.6-4.7 1.5-6.2Z" fill="#fff" />
          <circle cx="9.7" cy="12.4" r="1.2" fill={c} />
          <circle cx="14.3" cy="12.4" r="1.2" fill={c} />
        </>
      )}
      {type === 'whatsapp' && (
        <>
          <circle cx="12" cy="12" r="12" fill={c} />
          <path d="M12 5.5a6.4 6.4 0 0 0-5.5 9.7l-.8 3.1 3.2-.8A6.4 6.4 0 1 0 12 5.5Z" fill="none" stroke="#fff" stroke-width="1.5" stroke-linejoin="round" />
          <path d="M10 9.3c.2-.4.6-.4.8 0l.5 1.1c.1.2 0 .4-.1.6l-.3.3c.3.8 1 1.5 1.8 1.8l.3-.3c.2-.2.4-.2.6-.1l1.1.5c.4.2.4.6 0 .8-.6.5-1.4.6-2.1.3a5.3 5.3 0 0 1-2.9-2.9c-.3-.7-.2-1.5.3-2.1Z" fill="#fff" />
        </>
      )}
    </svg>
  );
}

type IconName =
  | 'search'
  | 'back'
  | 'send'
  | 'attach'
  | 'more'
  | 'check'
  | 'checks'
  | 'clock'
  | 'alert'
  | 'settings'
  | 'archive'
  | 'close'
  | 'download'
  | 'file'
  | 'pin'
  | 'plus'
  | 'copy'
  | 'camera'
  | 'users'
  | 'inbox'
  | 'retry'
  | 'bell'
  | 'bell-off'
  | 'key'
  | 'devices'
  | 'plug'
  | 'logout'
  | 'chevron'
  | 'trash'
  | 'filter'
  | 'play';

const PATHS: Record<IconName, JSX.Element> = {
  search: <path d="m21 21-4.3-4.3M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z" />,
  back: <path d="M15 5 8 12l7 7" />,
  send: <path d="M4 12 20 4l-6 16-3-7-7-1Z" />,
  attach: <path d="m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />,
  more: (
    <>
      <circle cx="12" cy="5" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="12" cy="19" r="1.4" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  checks: <path d="m2.5 12.5 4.5 4.5 9.5-9.5M11.5 16l1 1 9.5-9.5" />,
  clock: <path d="M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z" />,
  alert: <path d="M12 8v5M12 16.5v.5M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
  archive: <path d="M3 4h18v4H3zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  download: <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14" />,
  file: <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Zm0 0v5h5" />,
  pin: <path d="M12 21s-6.5-5.7-6.5-11a6.5 6.5 0 1 1 13 0c0 5.3-6.5 11-6.5 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  copy: <path d="M9 9h10v10a1 1 0 0 1-1 1H10a1 1 0 0 1-1-1V9Zm-4 6V5a1 1 0 0 1 1-1h9" />,
  camera: <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Zm8 9a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />,
  users: <path d="M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20m16 0v-1.5a3.5 3.5 0 0 0-2.5-3.4M15 4.2a3.5 3.5 0 0 1 0 6.6M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />,
  inbox: <path d="M3 13h5l1.5 3h5L16 13h5M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6l2.5-8Z" />,
  retry: <path d="M4 12a8 8 0 0 1 14-5.3M20 4v4h-4M20 12a8 8 0 0 1-14 5.3M4 20v-4h4" />,
  bell: <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Zm4 4h4" />,
  'bell-off': <path d="M6 16V11c0-1 .2-1.9.7-2.7M9.5 5.6A6 6 0 0 1 18 11v5l1.5 2H8m2 2h4M3 3l18 18" />,
  key: <path d="M14.5 9.5a4.5 4.5 0 1 0-4 4.5L13 16.5h2.5V19H18v2.5h3V18l-6.6-6.6c.1-.6.1-1.3.1-1.9Zm-5.5-.5h.01" />,
  devices: <path d="M4 6a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v8H4V6ZM2 17h12M17 11h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z" />,
  plug: <path d="M9 3v5m6-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v4" />,
  logout: <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  trash: <path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />,
  filter: <path d="M4 5h16l-6 7.5V19l-4 2v-8.5L4 5Z" />,
  play: <path d="M7 5v14l12-7L7 5Z" />,
};

export function Icon({ name, size = 20, class: cls }: { name: IconName; size?: number; class?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={`icon ${cls ?? ''}`}
    >
      {PATHS[name]}
    </svg>
  );
}
