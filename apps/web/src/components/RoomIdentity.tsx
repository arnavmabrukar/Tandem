import { Bot, UserRound } from 'lucide-react';
import openaiLogo from '../assets/openai.svg';
import claudeLogo from '../assets/claude.svg';
import metaLogo from '../assets/meta.svg';

export function RoomAvatar({ kind, client }: { kind: 'human' | 'agent' | 'mediator'; client?: string }) {
  const logo = kind === 'mediator' ? metaLogo : client === 'Codex' ? openaiLogo : client === 'Claude Code' ? claudeLogo : null;
  const label = kind === 'human' ? 'Human profile' : kind === 'mediator' ? 'Meta' : client ?? 'Agent';
  return <span className={`room-avatar room-avatar-${kind}`} role="img" aria-label={label}>
    {kind === 'human' ? <UserRound size={18} aria-hidden="true" /> : logo ? <img src={logo} alt="" /> : <Bot size={18} aria-hidden="true" />}
  </span>;
}

export function MediatorIdentity({ model }: { model?: string }) {
  return <><RoomAvatar kind="mediator" /><strong className="room-model-name">{model || 'Model unavailable'}</strong><span className="mediator-tag">Mediator</span></>;
}
