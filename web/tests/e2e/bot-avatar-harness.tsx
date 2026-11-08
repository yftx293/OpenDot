// Isolated presentation fixture. These states do not represent real executions.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BotAvatar,
  type BotAvatarState,
} from '../../src/components/common/BotAvatar';
import { avatarStateLabels } from '../../src/components/common/bot-avatar/state';
import '../../src/styles/globals.css';
import '../../src/styles/product.css';
const bots = ['Chief', 'Researcher', 'Developer'];
const states: BotAvatarState[] = [
  'idle',
  'working',
  'thinking',
  'waiting',
  'attention',
  'completed',
  'error',
];
function Fixture() {
  const [state, setState] = useState<BotAvatarState>('idle');
  return (
    <main style={{ padding: '16px', maxWidth: '960px', margin: 'auto' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 500 }}>
        Bot identity & motion
      </h1>
      <p className="text-sm text-muted-foreground">
        Presentation fixture · simulated states
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: '8px',
          marginTop: '16px',
        }}
      >
        {states.flatMap((status) =>
          bots.map((name) => (
            <div
              key={name + status}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                minHeight: '64px',
                flexWrap: 'wrap',
              }}
            >
              <BotAvatar
                botId={name.toLowerCase()}
                name={name}
                state={status}
              />
              <div>
                <p style={{ fontSize: '12px' }}>{name}</p>
                <p
                  className="text-muted-foreground"
                  style={{ fontSize: '11px' }}
                >
                  {avatarStateLabels[status]}
                </p>
              </div>
            </div>
          )),
        )}
      </div>
      <div
        style={{
          display: 'flex',
          gap: '12px',
          alignItems: 'center',
          marginBlock: '16px',
        }}
      >
        {(['xs', 'sm', 'md', 'lg'] as const).map((size) => (
          <BotAvatar key={size} botId="researcher" name={size} size={size} />
        ))}
        <BotAvatar
          botId="uploaded"
          name="Uploaded"
          imageUrl={
            'data:image/svg+xml,' +
            encodeURIComponent(
              '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#617c98"/></svg>',
            )
          }
        />
        <BotAvatar botId="emoji" name="Emoji" emoji="🐱" color="#344054" />
        <BotAvatar
          botId="broken"
          name="Fallback"
          imageUrl="/missing-avatar.png"
        />
      </div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '12px',
        }}
      >
        <button
          type="button"
          aria-label="Inspect Researcher"
          style={{
            display: 'flex',
            gap: '8px',
            alignItems: 'center',
            minHeight: '44px',
          }}
        >
          <BotAvatar
            botId="researcher"
            name="Interactive Researcher"
            state={state}
          />
          <span>Researcher</span>
        </button>
        <select
          aria-label="Preview state"
          value={state}
          onChange={(event) => setState(event.target.value as BotAvatarState)}
          style={{ minHeight: '44px', background: 'var(--surface)' }}
        >
          {states.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </div>
      <div style={{ height: '1200px' }} aria-hidden="true" />
      <div data-fixture="offscreen">
        <BotAvatar botId="offscreen" name="Offscreen" state="working" />
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
